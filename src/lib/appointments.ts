import type {
  DashboardAppointment,
  DashboardAppointmentVisit,
  DashboardData,
  DashboardResponse,
  DashboardVisit,
  OdooMany2One,
} from './dashboard-types.ts'

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
  // visitDate is the Amsterdam date (of the slot start, or of the visit when unscheduled). `start` is UTC,
  // so comparing it with `date` would drop an appointment just after midnight Amsterdam time.
  if (scope === 'upcoming') return appointment.visitDate >= date
  return appointment.visitDate === date
}

/*
 * Links every loaded visit to at most one loaded slot. The visit's own slot_id wins; when that
 * points at a slot that was not loaded (or is empty), a loaded slot that lists the visit in
 * svs_tech_visit_ids is used instead. Duplicate visit records are kept once. Visits that end up
 * without a loaded slot are not in the map and are shown as unscheduled appointments.
 */
export function groupVisitsBySlot(data: DashboardData) {
  const loadedSlotIds = new Set(data.slots.map((slot) => slot.id))
  const slotByListedVisit = new Map<number, number>()
  for (const slot of data.slots) {
    for (const visitId of slot.svs_tech_visit_ids ?? []) {
      if (!slotByListedVisit.has(visitId)) slotByListedVisit.set(visitId, slot.id)
    }
  }

  const visitsBySlot = new Map<number, DashboardVisit[]>()
  const seen = new Set<number>()
  for (const visit of data.visits) {
    if (seen.has(visit.id)) continue
    seen.add(visit.id)
    const ownSlotId = tupleId(visit.slot_id)
    const slotId = ownSlotId !== null && loadedSlotIds.has(ownSlotId) ? ownSlotId : slotByListedVisit.get(visit.id)
    if (slotId === undefined) continue
    const list = visitsBySlot.get(slotId) ?? []
    list.push(visit)
    visitsBySlot.set(slotId, list)
  }
  for (const list of visitsBySlot.values()) list.sort((a, b) => a.id - b.id)
  return visitsBySlot
}

/*
 * Status of an appointment with visits: the status of the first visit that is not finished yet, so an
 * appointment never reads "done" while a visit is still open. Only when every visit is done is it done.
 */
export function appointmentState(visits: Pick<DashboardAppointmentVisit, 'state'>[]): string | undefined {
  return (visits.find((visit) => visit.state !== 'done') ?? visits[0])?.state
}

export function buildAppointments(data: DashboardData, odooBaseUrl: string): DashboardAppointment[] {
  const makeOdooUrl = (model: string, id: number) => `${odooBaseUrl}/web#id=${id}&model=${model}&view_type=form`

  const visitsBySlot = groupVisitsBySlot(data)
  const toAppointmentVisit = (visit: DashboardVisit): DashboardAppointmentVisit => ({
    id: visit.id,
    // Odoo sends `false` for empty char/date fields.
    name: visit.name || '',
    state: visit.state || '',
    visitDate: visit.visit_date || '',
    technician: tupleName(visit.technician_id) || null,
    template: tupleName(visit.template_id) || null,
    isComplete: Boolean(visit.is_complete),
    isSent: Boolean(visit.is_sent),
    missingRequired: visit.missing_required_count ?? 0,
    missingInputs: visit.missing_required_inputs_count ?? 0,
    photoCount: visit.photo_count ?? 0,
    odooUrl: makeOdooUrl('svs.tech.visit', visit.id),
  })
  const total = (visits: DashboardAppointmentVisit[], pick: (visit: DashboardAppointmentVisit) => number) =>
    visits.length ? visits.reduce((sum, visit) => sum + pick(visit), 0) : null

  const appointments: DashboardAppointment[] = data.slots.map((slot) => {
    const visits = (visitsBySlot.get(slot.id) ?? []).map(toAppointmentVisit)
    const visit = visits[0]
    const peopleUnique = [...new Set([...relationNames(slot.employee_ids), ...relationNames(slot.user_ids)])]
    return {
      id: `slot-${slot.id}`,
      slotId: slot.id,
      visitId: visit?.id ?? null,
      visitName: visit?.name ?? null,
      visits,
      title: slot.name,
      start: slot.start_datetime,
      end: slot.end_datetime,
      visitDate: amsterdamDate(slot.start_datetime),
      customer: slot.partner_name || tupleName(slot.partner_id) || 'Onbekende klant',
      address: slot.partner_address || 'Adres ontbreekt',
      role: tupleName(slot.role_id) || 'Geen rol toegewezen',
      people: peopleUnique,
      state: appointmentState(visits) ?? slot.state,
      missingRequired: total(visits, (item) => item.missingRequired),
      missingInputs: total(visits, (item) => item.missingInputs),
      photoCount: total(visits, (item) => item.photoCount),
      travelTimeIn: slot.travel_time_in ?? null,
      travelTimeOut: slot.travel_time_out ?? null,
      travelTimesUpToDate: slot.travel_times_up_to_date,
      assigned: peopleUnique.length > 0,
      scheduled: true,
      odooUrl: visit?.odooUrl ?? null,
    } satisfies DashboardAppointment
  })

  const scheduledVisitIds = new Set([...visitsBySlot.values()].flatMap((visits) => visits.map((visit) => visit.id)))
  const unscheduledSeen = new Set<number>()
  for (const visit of data.visits) {
    if (scheduledVisitIds.has(visit.id) || unscheduledSeen.has(visit.id)) continue
    unscheduledSeen.add(visit.id)
    appointments.push({
      id: `visit-${visit.id}`,
      slotId: null,
      visitId: visit.id,
      visitName: visit.name,
      visits: [toAppointmentVisit(visit)],
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
