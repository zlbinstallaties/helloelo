import '@tanstack/react-start/server-only'
import { GatewayError } from '#/lib/gateway-error'
import { createEmployeeViaGateway } from '#/lib/gateway-employee'
import type { GatewayOutcome } from '#/lib/gateway-employee'
import { PAGE_SIZE, readAllPages } from '#/lib/paging'

/*
 * Odoo reads through the DIG Odoo gateway. SERVER-ONLY.
 *
 * The app holds only a gateway project token; the gateway holds the Odoo key
 * and enforces company, models, fields and read-only methods per project.
 *
 *   DIG_GATEWAY_URL    e.g. http://odoo-gateway:8070
 *   DIG_GATEWAY_TOKEN  project token for this app
 */

export { GatewayError }

function config() {
  const url = process.env.DIG_GATEWAY_URL
  const token = process.env.DIG_GATEWAY_TOKEN
  if (!url || !token) {
    throw new GatewayError('Odoo-gateway is niet ingesteld (DIG_GATEWAY_URL en DIG_GATEWAY_TOKEN).', 503, 'not_configured')
  }
  return { url, token }
}

export function gatewayConfigured() {
  return Boolean(process.env.DIG_GATEWAY_URL && process.env.DIG_GATEWAY_TOKEN)
}

export async function searchRead<T>(
  model: string,
  fields: string[],
  options: { limit?: number; offset?: number; order?: string } = {},
): Promise<T[]> {
  const { url, token } = config()
  let response: Response
  try {
    response = await fetch(new URL(`/v1/models/${model}/search_read`, url), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fields, limit: options.limit ?? PAGE_SIZE, offset: options.offset ?? 0, order: options.order }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new GatewayError('Odoo-gateway is niet bereikbaar.', 502, 'unreachable')
  }
  const body = (await response.json().catch(() => null)) as { records?: T[]; error?: string } | null
  if (!response.ok || !Array.isArray(body?.records)) {
    const code = typeof body?.error === 'string' ? body.error : null
    throw new GatewayError(`Odoo ${model} kon niet worden gelezen (${response.status}${code ? `: ${code}` : ''}).`, response.status, code)
  }
  return body.records
}

/**
 * Every record of a model, in pages (see `src/lib/paging.ts`). `order` must give every record a fixed place,
 * so end it with `id`; `truncated` is true when the maximum was reached and records were left behind.
 */
export async function searchReadAll<T extends { id: number }>(model: string, fields: string[], order: string) {
  return readAllPages<T>((offset, limit) => searchRead<T>(model, fields, { limit, offset, order }))
}

/**
 * The one write of the dashboard: a technician as an employee in Odoo, without an Odoo user (see
 * src/lib/gateway-employee.ts). Only a request id and a name are sent. The gateway decides company, responsible
 * and values, and refuses it unless its config switches the action on for this token.
 */
export async function createEmployee(input: { requestId: string; name: string }): Promise<GatewayOutcome> {
  if (!gatewayConfigured()) return { kind: 'not_enabled', message: 'Odoo-gateway is niet ingesteld (DIG_GATEWAY_URL en DIG_GATEWAY_TOKEN).' }
  const { url, token } = config()
  return createEmployeeViaGateway({ url, token, ...input })
}
