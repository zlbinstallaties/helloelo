import { createFileRoute } from '@tanstack/react-router'
import { getDigDashboardData } from '#/lib/cache'
import { GatewayError } from '#/lib/gateway.server'
import { buildAppointments, filterByTechnician, inScope, technicianOptions } from '#/lib/appointments'
import type { DashboardResponse } from '#/lib/dashboard-types'

// Only used to build links to Odoo forms; no credentials involved.
const ODOO_BASE_URL = process.env.ODOO_PUBLIC_URL ?? 'https://odoo20.srv1938209.hstgr.cloud'

async function responseFor(request: Request, refresh = false) {
  const url = new URL(request.url)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') ?? '')
    ? url.searchParams.get('date')!
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date())
  const requestedScope = url.searchParams.get('scope')
  const scope: DashboardResponse['scope'] = requestedScope === 'upcoming' || requestedScope === 'all' ? requestedScope : 'day'
  const technician = url.searchParams.get('technician') ?? ''
  const data = refresh ? await getDigDashboardData.refresh() : await getDigDashboardData()
  const all = buildAppointments(data, ODOO_BASE_URL)
  const appointments = filterByTechnician(
    all.filter((appointment) => inScope(appointment, date, scope)),
    technician,
  )
  const technicians = technicianOptions(all)

  return Response.json({
    company: data.company,
    appointments,
    technicians,
    scope,
    date,
    loadedAt: data.loadedAt,
  } satisfies DashboardResponse)
}

function errorResponse(error: unknown) {
  const status = error instanceof GatewayError && error.status === 503 ? 503 : 502
  return Response.json({ error: error instanceof Error ? error.message : 'Odoo kon niet worden gelezen.' }, { status })
}

export const Route = createFileRoute('/api/dashboard')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return await responseFor(request)
        } catch (error) {
          return errorResponse(error)
        }
      },
      POST: async ({ request }) => {
        try {
          return await responseFor(request, true)
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  },
})
