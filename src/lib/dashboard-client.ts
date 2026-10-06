import { api, ApiError } from './api-client.ts'
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
 * Calls /api/dashboard and returns the answer. Anything else becomes an `ApiError` with a message that can be
 * shown: the message of the server when it sent one, otherwise `fallback` with the HTTP status. The status
 * stays in the error, so the screen can send a person whose session ended (401) back to the login.
 */
export async function requestDashboard(
  params: URLSearchParams,
  method: 'GET' | 'POST',
  fallback: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardResponse> {
  const payload = await api<Partial<DashboardResponse>>(`/api/dashboard?${params}`, { method, fallback }, fetchImpl)
  if (!Array.isArray(payload.appointments)) throw new ApiError(200, 'Onverwacht antwoord van de server.')
  return payload as DashboardResponse
}
