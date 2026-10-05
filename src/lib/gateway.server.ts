import '@tanstack/react-start/server-only'

/*
 * Odoo reads through the DIG Odoo gateway. SERVER-ONLY.
 *
 * The app holds only a gateway project token; the gateway holds the Odoo key
 * and enforces company, models, fields and read-only methods per project.
 *
 *   DIG_GATEWAY_URL    e.g. http://odoo-gateway:8070
 *   DIG_GATEWAY_TOKEN  project token for this app
 */

export class GatewayError extends Error {
  status: number
  code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
  }
}

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

export async function searchRead<T>(model: string, fields: string[], options: { limit?: number } = {}): Promise<T[]> {
  const { url, token } = config()
  let response: Response
  try {
    response = await fetch(new URL(`/v1/models/${model}/search_read`, url), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fields, limit: options.limit ?? 500 }),
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
