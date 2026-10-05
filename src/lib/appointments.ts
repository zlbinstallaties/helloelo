import type { DashboardAppointment, DashboardData, DashboardResponse, OdooMany2One } from './dashboard-types.ts'

/*
 * Pure dashboard logic: turns the raw Odoo records into appointments and applies
 * the period and technician filters. No I/O, so it is unit-tested in test/.
 */

export function tupleName(value: OdooMany2One) {
  return value ? value[1] : ''
}

export function tupleId(value: OdooMany2One) {
  return value ? value[0] : null
}

export function relationNames(value: unknown) {
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

export function amsterdamDate(value: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(
    new Date(`${value.replace(' ', 'T')}Z`),
  )
}

export function inScope(
  appointment: DashboardAppointment,
  date: string,
  scope: DashboardResponse['scope'],
) {
  if (scope === 'all') return true
  if (scope === 'upcoming') return appointment.start ? appointment.start >= date : appointment.visitDate >= date
  return appointment.visitDate === date
}

export function buildAppointments(data: DashboardData, odooBaseUrl: string): DashboardAppointment[] {
  const makeOdooUrl = (model: string, id: number) => `${odooBaseUrl}/web#id=${id}&model=${model}&view_type=form`

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

export function filterByTechnician(appointments: DashboardAppointment[], technician: string) {
  if (!technician) return appointments
  return appointments.filter((appointment) => appointment.people.includes(technician))
}
