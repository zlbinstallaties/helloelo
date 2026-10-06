import type {
  DashboardAppointment,
  DashboardAppointmentVisit,
  DashboardData,
  DashboardPerson,
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

type PersonKind = 'employee' | 'user'
type RawPerson = { kind: PersonKind; id: number | null; name: string }

/*
 * The assignees in a many2many field. Odoo sends [id, name] pairs; plain ids, records and bare names are
 * accepted too, so a different wire format still gives every person an id where Odoo sent one.
 */
function relationPeople(value: unknown, kind: PersonKind): RawPerson[] {
  if (!Array.isArray(value)) return []
  const people: RawPerson[] = []
  for (const item of value) {
    let id: number | null = null
    let name = ''
    if (typeof item === 'number') {
      id = item
    } else if (Array.isArray(item)) {
      if (typeof item[0] === 'number') id = item[0]
      if (typeof item[1] === 'string') name = item[1]
    } else if (typeof item === 'object' && item !== null) {
      if ('id' in item && typeof item.id === 'number') id = item.id
      if ('display_name' in item && typeof item.display_name === 'string') name = item.display_name
      else if ('name' in item && typeof item.name === 'string') name = item.name
    } else if (typeof item === 'string') {
      name = item
    }
    if (id !== null || name) people.push({ kind, id, name })
  }
  return people
}

/*
 * A user and an employee are different Odoo records with different ids, and nothing we read links them.
 * The only evidence is a slot that lists both under the same name, so that is taken as one person; the
 * person then keeps the employee id everywhere the user appears (other slots, the technician of a visit).
 * Not linked when the evidence is ambiguous: several people with that name in the slot, or the same user
 * matching different employees in different slots.
 */
function userAliases(slots: DashboardData['slots']) {
  const aliases = new Map<number, number | null>()
  for (const slot of slots) {
    const employees = relationPeople(slot.employee_ids, 'employee').filter((person) => person.id !== null && person.name)
    const users = relationPeople(slot.user_ids, 'user').filter((person) => person.id !== null && person.name)
    for (const user of users) {
      const employeesWithName = employees.filter((person) => person.name === user.name)
      const usersWithName = users.filter((person) => person.name === user.name)
      if (employeesWithName.length !== 1 || usersWithName.length !== 1) continue
      const employeeId = employeesWithName[0].id as number
      const known = aliases.get(user.id as number)
      if (known === undefined) aliases.set(user.id as number, employeeId)
      else if (known !== employeeId) aliases.set(user.id as number, null)
    }
  }
  return aliases
}

/** The user ids that count as the same person as each employee id (see `userAliases`). */
function aliasIdsByEmployee(aliases: Map<number, number | null>) {
  const byEmployee = new Map<number, string[]>()
  for (const [userId, employeeId] of aliases) {
    if (employeeId === null) continue
    byEmployee.set(employeeId, [...(byEmployee.get(employeeId) ?? []), `user:${userId}`].sort())
  }
  return byEmployee
}

function resolvePeople(
  raw: RawPerson[],
  aliases: Map<number, number | null>,
  aliasIds: Map<number, string[]>,
): DashboardPerson[] {
  const people = new Map<string, DashboardPerson>()
  for (const person of raw) {
    const employeeId = person.kind === 'user' && person.id !== null ? aliases.get(person.id) : undefined
    const kind = typeof employeeId === 'number' ? 'employee' : person.kind
    const id = typeof employeeId === 'number' ? employeeId : person.id
    const key = id !== null ? `${kind}:${id}` : `name:${person.name}`
    if (people.has(key)) continue
    const fallback = kind === 'employee' ? `Medewerker ${id}` : `Gebruiker ${id}`
    const alsoIds = kind === 'employee' && id !== null ? (aliasIds.get(id) ?? []) : []
    people.set(key, { id: key, name: person.name || fallback, ...(alsoIds.length ? { alsoIds } : {}) })
  }
  return [...people.values()]
}

/** True when `id` is the id of this person or one of the other ids they are known under. */
export function personHasId(person: DashboardPerson, id: string) {
  return person.id === id || Boolean(person.alsoIds?.includes(id))
}

const KIND_LABEL: Record<string, string> = { employee: 'medewerker', user: 'gebruiker' }

/*
 * The choices of the technician filter: one per person id, sorted by name. People who share a name get
 * their Odoo id behind it, so every choice can be picked on its own.
 */
export function technicianOptions(appointments: DashboardAppointment[]) {
  const nameById = new Map<string, string>()
  for (const appointment of appointments) {
    for (const person of appointment.people) if (!nameById.has(person.id)) nameById.set(person.id, person.name)
  }
  const nameCount = new Map<string, number>()
  for (const name of nameById.values()) nameCount.set(name, (nameCount.get(name) ?? 0) + 1)
  return [...nameById]
    .map(([value, name]) => {
      if ((nameCount.get(name) ?? 0) < 2) return { value, label: name }
      const [kind, id] = value.split(':')
      return { value, label: `${name} (${KIND_LABEL[kind] ? `${KIND_LABEL[kind]} ${id}` : 'zonder Odoo-id'})` }
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'nl') || a.value.localeCompare(b.value))
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
  const aliases = userAliases(data.slots)
  const aliasIds = aliasIdsByEmployee(aliases)
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
    const people = resolvePeople(
      [...relationPeople(slot.employee_ids, 'employee'), ...relationPeople(slot.user_ids, 'user')],
      aliases,
      aliasIds,
    )
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
      people,
      state: appointmentState(visits) ?? slot.state,
      missingRequired: total(visits, (item) => item.missingRequired),
      missingInputs: total(visits, (item) => item.missingInputs),
      photoCount: total(visits, (item) => item.photoCount),
      travelTimeIn: slot.travel_time_in ?? null,
      travelTimeOut: slot.travel_time_out ?? null,
      travelTimesUpToDate: slot.travel_times_up_to_date,
      assigned: people.length > 0,
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
      people: resolvePeople(relationPeople(visit.technician_id ? [visit.technician_id] : [], 'user'), aliases, aliasIds),
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

/** `technician` is a person id as in `technicianOptions` (e.g. `employee:7`); empty keeps everything. */
export function filterByTechnician(appointments: DashboardAppointment[], technician: string) {
  if (!technician) return appointments
  return appointments.filter((appointment) => appointment.people.some((person) => personHasId(person, technician)))
}
