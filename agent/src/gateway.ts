/*
 * Reads the project schema from the DIG Odoo gateway (GET /v1/schema). The
 * agent only sees model and field metadata, never records or the Odoo key.
 */

export function createSchemaReader(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  const url = new URL('/v1/schema', baseUrl)
  let cached: unknown
  return async function odooSchema(): Promise<unknown> {
    if (cached !== undefined) return cached
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new Error('Odoo-gateway niet bereikbaar')
    }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    if (!response.ok) {
      throw new Error(`Odoo-gateway gaf ${response.status}${typeof body?.error === 'string' ? `: ${body.error}` : ''}`)
    }
    cached = body
    return cached
  }
}
