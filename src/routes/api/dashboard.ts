import { createFileRoute } from '@tanstack/react-router'
import { getDigDashboardData } from '#/lib/cache'
import { GatewayError } from '#/lib/gateway.server'
import type {
  DashboardAppointment,
  DashboardData,
  DashboardResponse,
  OdooMany2One,
} from '#/lib/dashboard-types'

// Only used to build links to Odoo forms; no credentials involved.
const ODOO_BASE_URL = process.env.ODOO_PUBLIC_URL ?? 'https://odoo20.srv1938209.hstgr.cloud'

function tupleName(value: OdooMany2One) {
  return value ? value[1] : ''
}

function tupleId(value: OdooMany2One) {
  return value ? value[0] : null
}

function relationNames(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (Array.isArray(item)) return item[1]
      if (typeof item === 'object' && item !== null) {
        if ('display_name' in item) return item.display_name
        if ('name' in item) return item.name
      }
      return typeof item === 'string' ? item : ''
    })
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function amsterdamDate(value: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(
    new Date(`${value.replace(' ', 'T')}Z`),
  )
}

function inScope(
  appointment: DashboardAppointment,
  date: string,
  scope: DashboardResponse['scope'],
) {
  if (scope === 'all') return true
  if (scope === 'upcoming') return appointment.start ? appointment.start >= date : appointment.visitDate >= date
  return appointment.visitDate === date
}

function makeOdooUrl(model: string, id: number) {
  return `${ODOO_BASE_URL}/web#id=${id}&model=${model}&view_type=form`
}

function buildAppointments(data: DashboardData): DashboardAppointment[] {
  const visitsBySlot = new Map<number, DashboardData['visits'][number]>()
  for (const visit of data.visits) {
    const slotId = tupleId(visit.slot_id)
    if (slotId) visitsBySlot.set(slotId, visit)
  }

  const appointments: DashboardAppointment[] = data.slots.map((slot) => {
    const visit = visitsBySlot.get(slot.id)
    const peopleUnique = [...new Set([...relationNames(slot.employee_ids), ...relationNames(slot.user_ids)])]
    return {
      id: `slot-${slot.id}`,
      slotId: slot.id,
      visitId: visit?.id ?? null,
      visitName: visit?.name ?? null,
      title: slot.name,
      start: slot.start_datetime,
      end: slot.end_datetime,
      visitDate: amsterdamDate(slot.start_datetime),
      customer: slot.partner_name || tupleName(slot.partner_id) || 'Onbekende klant',
      address: slot.partner_address || 'Adres ontbreekt',
      role: tupleName(slot.role_id) || 'Geen rol toegewezen',
      people: peopleUnique,
      state: visit?.state ?? slot.state,
      missingRequired: visit?.missing_required_count ?? null,
      missingInputs: visit?.missing_required_inputs_count ?? null,
      photoCount: visit?.photo_count ?? null,
      travelTimeIn: slot.travel_time_in ?? null,
      travelTimeOut: slot.travel_time_out ?? null,
      travelTimesUpToDate: slot.travel_times_up_to_date,
      assigned: peopleUnique.length > 0,
      scheduled: true,
      odooUrl: visit ? makeOdooUrl('svs.tech.visit', visit.id) : null,
    } satisfies DashboardAppointment
  })

  const scheduledVisitIds = new Set(data.slots.flatMap((slot) => slot.svs_tech_visit_ids))
  for (const visit of data.visits) {
    if (scheduledVisitIds.has(visit.id)) continue
    appointments.push({
      id: `visit-${visit.id}`,
      slotId: null,
      visitId: visit.id,
      visitName: visit.name,
      title: visit.name,
      start: null,
      end: null,
      visitDate: visit.visit_date,
      customer: tupleName(visit.partner_id) || 'Onbekende klant',
      address: 'Adres ontbreekt in het bezoekformulier',
      role: 'Niet gepland',
      people: visit.technician_id ? [tupleName(visit.technician_id)] : [],
      state: visit.state,
      missingRequired: visit.missing_required_count,
      missingInputs: visit.missing_required_inputs_count,
      photoCount: visit.photo_count,
      travelTimeIn: null,
      travelTimeOut: null,
      travelTimesUpToDate: false,
      assigned: Boolean(visit.technician_id),
      scheduled: false,
      odooUrl: makeOdooUrl('svs.tech.visit', visit.id),
    })
  }

  return appointments.sort((a, b) => (a.start ?? `${a.visitDate}T00:00:00`).localeCompare(b.start ?? `${b.visitDate}T00:00:00`))
}

function filterByTechnician(appointments: DashboardAppointment[], technician: string) {
  if (!technician) return appointments
  return appointments.filter((appointment) => appointment.people.includes(technician))
}

async function responseFor(request: Request, refresh = false) {
  const url = new URL(request.url)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') ?? '')
    ? url.searchParams.get('date')!
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date())
  const requestedScope = url.searchParams.get('scope')
  const scope: DashboardResponse['scope'] = requestedScope === 'upcoming' || requestedScope === 'all' ? requestedScope : 'day'
  const technician = url.searchParams.get('technician') ?? ''
  const data = refresh ? await getDigDashboardData.refresh() : await getDigDashboardData()
  const appointments = filterByTechnician(
    buildAppointments(data).filter((appointment) => inScope(appointment, date, scope)),
    technician,
  )
  const technicians = [...new Set(buildAppointments(data).flatMap((item) => item.people))]
    .filter((label): label is string => typeof label === 'string' && label.length > 0)
    .sort((a, b) => a.localeCompare(b, 'nl'))
    .map((label) => ({ value: label, label }))

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
