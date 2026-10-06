import type { DashboardResponse } from './dashboard-types.ts'

/*
 * Browser side of /api/dashboard, shared by loading (GET) and refreshing (POST) so both read the answer and
 * its errors the same way. No React in here, so it is unit-tested in test/.
 */

export function dashboardParams(date: string, scope: DashboardResponse['scope'], technician: string) {
  const params = new URLSearchParams({ date, scope })
  if (technician) params.set('technician', technician)
  return params
}

/**
 * Calls /api/dashboard and returns the answer. Anything else becomes an Error with a message that can be shown:
 * the message of the server when it sent one, otherwise `fallback` with the HTTP status.
 */
export async function requestDashboard(
  params: URLSearchParams,
  method: 'GET' | 'POST',
  fallback: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardResponse> {
  let response: Response
  try {
    response = await fetchImpl(`/api/dashboard?${params}`, { method })
  } catch {
    throw new Error('De server is niet bereikbaar.')
  }
  const payload = (await response.json().catch(() => null)) as (Partial<DashboardResponse> & { error?: unknown }) | null
  if (!response.ok) {
    const message = typeof payload?.error === 'string' && payload.error ? payload.error : `${fallback} (HTTP ${response.status})`
    throw new Error(message)
  }
  if (!payload || !Array.isArray(payload.appointments)) throw new Error('Onverwacht antwoord van de server.')
  return payload as DashboardResponse
}
