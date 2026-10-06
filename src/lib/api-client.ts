/*
 * The browser side of every call to the dashboard's own API: JSON in, JSON out, errors as one kind of error.
 * Everything that changes something carries the header `X-Dig-Dashboard: 1`; the server refuses such a request
 * without it, which a form or script on another site cannot add. No React in here, so it is unit-tested in test/.
 */

export class ApiError extends Error {
  /** HTTP status; 0 when the server could not be reached. */
  status: number
  /** The whole error answer of the server (for example `employeeId`). */
  data: Record<string, unknown>

  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; fallback?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['x-dig-dashboard'] = '1'
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetchImpl(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
  } catch {
    throw new ApiError(0, 'De server is niet bereikbaar.')
  }
  const payload = (await response.json().catch(() => null)) as unknown
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error ? data.error : `${init.fallback ?? 'Het verzoek is mislukt.'} (HTTP ${response.status})`
    throw new ApiError(response.status, message, data ?? {})
  }
  if (!data) throw new ApiError(response.status, 'Onverwacht antwoord van de server.')
  return data as T
}
