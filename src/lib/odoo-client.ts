/*
 * Standalone, read-only Odoo client (External JSON-2 API, Odoo 19+).
 *
 * No platform imports on purpose: this file can run in a Worker, Node or a
 * test. Config and secrets are injected by `odoo.server.ts`.
 *
 * Safety properties:
 *  - Only `search_read` is exposed. No create / write / unlink / generic call.
 *  - Models are checked against an allowlist given at construction time.
 *  - A company filter is always added to the domain and to the context.
 *  - The API key is sent only in the Authorization header and never ends up
 *    in error messages.
 */

export interface OdooClientConfig {
  /** e.g. https://mijnbedrijf.odoo.com (no trailing path). */
  baseUrl: string
  /** Odoo API key of a dedicated user with minimal read rights. */
  apiKey: string
  /** X-Odoo-Database; needed when the server hosts several databases. */
  database?: string
  /** Models this client may read. Anything else is refused. */
  allowedModels: readonly string[]
  timeoutMs?: number
  /** Injectable for tests. */
  fetch?: typeof fetch
}

export interface SearchReadParams {
  model: string
  fields: string[]
  /** Extra domain; the company filter is always added on top. */
  domain?: unknown[]
  companyId: number
  limit?: number
  offset?: number
  order?: string
}

export interface OdooClient {
  searchRead<T = Record<string, unknown>>(params: SearchReadParams): Promise<T[]>
}

export class OdooError extends Error {
  status: number
  odooName: string | null

  constructor(message: string, status: number, odooName: string | null = null) {
    super(message)
    this.name = 'OdooError'
    this.status = status
    this.odooName = odooName
  }
}

const MODEL_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const FIELD_PATTERN = /^[a-z_][a-z0-9_]*$/
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 500
const DEFAULT_TIMEOUT_MS = 15_000

function normalizeBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OdooError('ODOO_BASE_URL is not a valid URL', 0)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new OdooError('ODOO_BASE_URL must use https', 0)
  }
  return url.origin
}

export function createOdooClient(config: OdooClientConfig): OdooClient {
  if (!config.apiKey) throw new OdooError('Odoo API key is missing', 0)
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const allowed = new Set(config.allowedModels)
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function searchRead<T>(params: SearchReadParams): Promise<T[]> {
    const { model } = params
    if (!MODEL_PATTERN.test(model) || !allowed.has(model)) {
      throw new OdooError(`Model not allowed: ${model}`, 0)
    }
    if (!Number.isInteger(params.companyId) || params.companyId <= 0) {
      throw new OdooError('companyId is required', 0)
    }
    if (params.fields.length === 0 || !params.fields.every((f) => FIELD_PATTERN.test(f))) {
      throw new OdooError('Invalid field list', 0)
    }
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = Math.max(params.offset ?? 0, 0)

    const body: Record<string, unknown> = {
      domain: [['company_id', '=', params.companyId], ...(params.domain ?? [])],
      fields: params.fields,
      limit,
      offset,
      context: { allowed_company_ids: [params.companyId] },
    }
    if (params.order) body.order = params.order

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `bearer ${config.apiKey}`,
    }
    if (config.database) headers['X-Odoo-Database'] = config.database

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await doFetch(`${baseUrl}/json/2/${model}/search_read`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError'
      throw new OdooError(
        timedOut ? `Odoo ${model} read timed out` : `Odoo ${model} read failed (network)`,
        0,
      )
    } finally {
      clearTimeout(timer)
    }

    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      // handled below
    }

    if (!response.ok) {
      const info = (payload && typeof payload === 'object' ? payload : {}) as {
        name?: unknown
        message?: unknown
      }
      const odooName = typeof info.name === 'string' ? info.name : null
      const message = typeof info.message === 'string' ? info.message.slice(0, 200) : ''
      throw new OdooError(
        `Odoo ${model} read failed (${response.status})${message ? `: ${message}` : ''}`,
        response.status,
        odooName,
      )
    }
    if (!Array.isArray(payload)) {
      throw new OdooError(`Odoo ${model} returned an unexpected response`, response.status)
    }
    return payload as T[]
  }

  return { searchRead }
}
