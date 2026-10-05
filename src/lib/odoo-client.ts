/*
 * Standalone, read-only Odoo client (External JSON-2 API, Odoo 19+).
 *
 * No platform imports on purpose: this file can run in a Worker, Node or a
 * test. Config and secrets are injected by `odoo.server.ts`.
 *
 * Safety properties:
 *  - Only read methods are exposed (`search_read`, `search_count`,
 *    `fields_get`). No create / write / unlink / generic call.
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

export interface SearchCountParams {
  model: string
  /** Extra domain; the company filter is always added on top. */
  domain?: unknown[]
  companyId: number
}

export interface OdooFieldInfo {
  type: string
  string?: string
  relation?: string
  required?: boolean
  readonly?: boolean
  [key: string]: unknown
}

export interface OdooClient {
  searchRead<T = Record<string, unknown>>(params: SearchReadParams): Promise<T[]>
  searchCount(params: SearchCountParams): Promise<number>
  /** Field definitions of an allowed model; contains no records. */
  fieldsGet(model: string, attributes?: string[]): Promise<Record<string, OdooFieldInfo>>
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
const DEFAULT_FIELD_ATTRIBUTES = ['type', 'string', 'relation', 'required', 'readonly']

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

  function checkModel(model: string) {
    if (!MODEL_PATTERN.test(model) || !allowed.has(model)) {
      throw new OdooError(`Model not allowed: ${model}`, 0)
    }
  }

  function checkCompany(companyId: number) {
    if (!Number.isInteger(companyId) || companyId <= 0) {
      throw new OdooError('companyId is required', 0)
    }
  }

  async function call(model: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `bearer ${config.apiKey}`,
    }
    if (config.database) headers['X-Odoo-Database'] = config.database

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await doFetch(`${baseUrl}/json/2/${model}/${method}`, {
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
    return payload
  }

  async function searchRead<T>(params: SearchReadParams): Promise<T[]> {
    const { model } = params
    checkModel(model)
    checkCompany(params.companyId)
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

    const payload = await call(model, 'search_read', body)
    if (!Array.isArray(payload)) {
      throw new OdooError(`Odoo ${model} returned an unexpected response`, 200)
    }
    return payload as T[]
  }

  async function searchCount(params: SearchCountParams): Promise<number> {
    const { model } = params
    checkModel(model)
    checkCompany(params.companyId)
    const payload = await call(model, 'search_count', {
      domain: [['company_id', '=', params.companyId], ...(params.domain ?? [])],
      context: { allowed_company_ids: [params.companyId] },
    })
    if (typeof payload !== 'number' || !Number.isInteger(payload)) {
      throw new OdooError(`Odoo ${model} returned an unexpected response`, 200)
    }
    return payload
  }

  async function fieldsGet(model: string, attributes = DEFAULT_FIELD_ATTRIBUTES) {
    checkModel(model)
    if (!attributes.every((a) => FIELD_PATTERN.test(a))) {
      throw new OdooError('Invalid attribute list', 0)
    }
    const payload = await call(model, 'fields_get', { attributes })
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new OdooError(`Odoo ${model} returned an unexpected response`, 200)
    }
    return payload as Record<string, OdooFieldInfo>
  }

  return { searchRead, searchCount, fieldsGet }
}
