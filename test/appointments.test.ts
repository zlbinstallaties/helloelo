import test from 'node:test'
import assert from 'node:assert/strict'
import {
  amsterdamDate,
  appointmentState,
  buildAppointments,
  filterByTechnician,
  inScope,
  technicianOptions,
} from '../src/lib/appointments.ts'
import type { DashboardData, DashboardSlot, DashboardVisit } from '../src/lib/dashboard-types.ts'

const BASE = 'https://odoo.example'

function slot(id: number, overrides: Partial<DashboardSlot> = {}): DashboardSlot {
  return {
    id,
    name: `Slot ${id}`,
    start_datetime: '2026-10-05 07:00:00',
    end_datetime: '2026-10-05 09:00:00',
    allocated_hours: 2,
    role_id: [1, 'Monteur'],
    user_ids: [],
    employee_ids: [],
    partner_id: [10, 'Klant'],
    partner_name: 'Klant',
    partner_address: 'Straat 1',
    sale_order_id: false,
    sale_line_id: false,
    state: 'published',
    svs_tech_visit_ids: [],
    travel_time_in: 10,
    travel_time_out: 10,
    travel_times_up_to_date: true,
    ...overrides,
  }
}

function visit(id: number, overrides: Partial<DashboardVisit> = {}): DashboardVisit {
  return {
    id,
    name: `TV/${id}`,
    state: 'in_progress',
    visit_date: '2026-10-05',
    partner_id: [10, 'Klant'],
    technician_id: [5, 'Jan'],
    template_id: [1, 'Sjabloon'],
    slot_id: false,
    task_id: false,
    is_complete: false,
    is_sent: false,
    missing_required_count: 1,
    missing_required_inputs_count: 1,
    photo_count: 2,
    photo_ids: [],
    notes: '',
    ...overrides,
  }
}

function data(slots: DashboardSlot[], visits: DashboardVisit[]): DashboardData {
  return { company: { id: 2, name: 'Test' }, slots, visits, truncated: false, loadedAt: '2026-10-05T00:00:00Z' }
}

test('a visit linked through slot_id fills the summary fields of its appointment', () => {
  const [appointment] = buildAppointments(data([slot(1)], [visit(100, { slot_id: [1, 'Slot 1'] })]), BASE)
  assert.equal(appointment.visitId, 100)
  assert.equal(appointment.visitName, 'TV/100')
  assert.equal(appointment.missingRequired, 1)
  assert.equal(appointment.photoCount, 2)
  assert.equal(appointment.odooUrl, `${BASE}/web#id=100&model=svs.tech.visit&view_type=form`)
  assert.equal(appointment.scheduled, true)
})

test('an appointment without a visit has no form data', () => {
  const [appointment] = buildAppointments(data([slot(1)], []), BASE)
  assert.equal(appointment.visitId, null)
  assert.equal(appointment.missingRequired, null)
  assert.equal(appointment.odooUrl, null)
})

test('a visit without a slot is listed as an unscheduled appointment', () => {
  const list = buildAppointments(data([], [visit(100)]), BASE)
  assert.equal(list.length, 1)
  assert.equal(list[0].scheduled, false)
  assert.equal(list[0].slotId, null)
  assert.equal(list[0].role, 'Niet gepland')
  assert.deepEqual(list[0].people, [{ id: 'user:5', name: 'Jan' }])
})

test('a visit that points at a slot that was not loaded still shows up as unscheduled', () => {
  const list = buildAppointments(data([slot(1)], [visit(100, { slot_id: [99, 'Slot buiten de selectie'] })]), BASE)
  assert.deepEqual(list.map((a) => [a.slotId, a.visitId, a.scheduled]), [[1, null, true], [null, 100, false]])
})

test('a visit that the slot lists itself is not repeated as an unscheduled appointment', () => {
  const list = buildAppointments(data([slot(1, { svs_tech_visit_ids: [100] })], [visit(100)]), BASE)
  assert.equal(list.length, 1)
})

test('an appointment with several visits lists all of them, sorted by id, with totals', () => {
  const [appointment, ...rest] = buildAppointments(
    data(
      [slot(1, { svs_tech_visit_ids: [101, 100] })],
      [
        visit(101, { slot_id: [1, 'Slot 1'], missing_required_count: 0, photo_count: 3, technician_id: false }),
        visit(100, { slot_id: [1, 'Slot 1'] }),
      ],
    ),
    BASE,
  )
  assert.equal(rest.length, 0)
  assert.deepEqual(appointment.visits.map((v) => v.id), [100, 101])
  assert.equal(appointment.visitId, 100)
  assert.equal(appointment.odooUrl, `${BASE}/web#id=100&model=svs.tech.visit&view_type=form`)
  assert.equal(appointment.visits[1].odooUrl, `${BASE}/web#id=101&model=svs.tech.visit&view_type=form`)
  assert.equal(appointment.visits[1].technician, null)
  assert.equal(appointment.missingRequired, 1)
  assert.equal(appointment.missingInputs, 2)
  assert.equal(appointment.photoCount, 5)
})

test('a visit that only the slot lists (no slot_id) belongs to that slot', () => {
  const list = buildAppointments(
    data([slot(1, { svs_tech_visit_ids: [100, 101] })], [visit(100, { slot_id: [1, 'Slot 1'] }), visit(101)]),
    BASE,
  )
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].visits.map((v) => v.id), [100, 101])
})

test('a visit whose slot_id points at a loaded slot is not repeated as unscheduled, even if the slot does not list it', () => {
  const list = buildAppointments(data([slot(1)], [visit(100, { slot_id: [1, 'Slot 1'] }), visit(101, { slot_id: [1, 'Slot 1'] })]), BASE)
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].visits.map((v) => v.id), [100, 101])
})

test('a visit is linked to one slot only: its own loaded slot_id wins over another slot listing it', () => {
  const list = buildAppointments(
    data([slot(1, { svs_tech_visit_ids: [100] }), slot(2)], [visit(100, { slot_id: [2, 'Slot 2'] })]),
    BASE,
  )
  const bySlot = Object.fromEntries(list.map((a) => [a.slotId, a.visits.map((v) => v.id)]))
  assert.deepEqual(bySlot, { 1: [], 2: [100] })
})

test('a visit with a not-loaded slot_id falls back to a loaded slot that lists it', () => {
  const list = buildAppointments(data([slot(1, { svs_tech_visit_ids: [100] })], [visit(100, { slot_id: [99, 'Elders'] })]), BASE)
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].visits.map((v) => v.id), [100])
})

test('duplicate visit records and listed visits that were not loaded are handled', () => {
  const list = buildAppointments(
    data([slot(1, { svs_tech_visit_ids: [100, 555] })], [visit(100, { slot_id: [1, 'Slot 1'] }), visit(100, { slot_id: [1, 'Slot 1'] }), visit(200), visit(200)]),
    BASE,
  )
  assert.deepEqual(list.map((a) => [a.id, a.visits.map((v) => v.id)]), [['slot-1', [100]], ['visit-200', [200]]])
})

test('an appointment without visits has an empty visit list and no totals', () => {
  const [appointment] = buildAppointments(data([slot(1)], []), BASE)
  assert.deepEqual(appointment.visits, [])
  assert.equal(appointment.photoCount, null)
  assert.equal(appointment.missingInputs, null)
})

test('an employee and a user with the same name in one slot are one person', () => {
  const [appointment] = buildAppointments(
    data([slot(1, { employee_ids: [[7, 'Jan'], [8, 'Sanne']], user_ids: [[5, 'Jan']] })], []),
    BASE,
  )
  assert.deepEqual(appointment.people, [
    { id: 'employee:7', name: 'Jan' },
    { id: 'employee:8', name: 'Sanne' },
  ])
  assert.equal(appointment.assigned, true)
  assert.equal(buildAppointments(data([slot(2)], []), BASE)[0].assigned, false)
})

test('appointments are sorted by start time; an unscheduled visit comes after the timed ones of its day', () => {
  const list = buildAppointments(
    data(
      [slot(1, { start_datetime: '2026-10-05 13:00:00' }), slot(2, { start_datetime: '2026-10-05 07:00:00' })],
      [visit(100, { visit_date: '2026-10-05' })],
    ),
    BASE,
  )
  assert.deepEqual(list.map((a) => a.id), ['slot-2', 'slot-1', 'visit-100'])
})

test('dates are shown in Amsterdam time, also around the switch to winter time', () => {
  assert.equal(amsterdamDate('2026-10-05 07:00:00'), '2026-10-05')
  assert.equal(amsterdamDate('2026-10-24 22:30:00'), '2026-10-25') // CEST, UTC+2
  assert.equal(amsterdamDate('2026-10-25 22:30:00'), '2026-10-25') // CET, UTC+1
  assert.equal(amsterdamDate('2026-10-25 23:30:00'), '2026-10-26')
})

test('period filters: day, upcoming and all', () => {
  const list = buildAppointments(
    data(
      [slot(1, { start_datetime: '2026-10-04 08:00:00' }), slot(2), slot(3, { start_datetime: '2026-10-06 08:00:00' })],
      [visit(100, { visit_date: '2026-10-07' })],
    ),
    BASE,
  )
  const ids = (scope: 'day' | 'upcoming' | 'all') => list.filter((a) => inScope(a, '2026-10-05', scope)).map((a) => a.id)
  assert.deepEqual(ids('day'), ['slot-2'])
  assert.deepEqual(ids('upcoming'), ['slot-2', 'slot-3', 'visit-100'])
  assert.deepEqual(ids('all'), ['slot-1', 'slot-2', 'slot-3', 'visit-100'])
})

test('period filters use the Amsterdam date, also for appointments just after midnight', () => {
  const list = buildAppointments(
    data(
      [
        // 2026-10-05 22:30 UTC = 6 October 00:30 in Amsterdam (summer time)
        slot(1, { start_datetime: '2026-10-05 22:30:00' }),
        // 2026-10-05 20:00 UTC = 5 October 22:00 in Amsterdam: still the day before
        slot(2, { start_datetime: '2026-10-05 20:00:00' }),
        // 2026-12-05 23:30 UTC = 6 December 00:30 in Amsterdam (winter time)
        slot(3, { start_datetime: '2026-12-05 23:30:00' }),
      ],
      [],
    ),
    BASE,
  )
  const ids = (date: string, scope: 'day' | 'upcoming' | 'all') =>
    list.filter((a) => inScope(a, date, scope)).map((a) => a.id)
  assert.deepEqual(ids('2026-10-06', 'day'), ['slot-1'])
  assert.deepEqual(ids('2026-10-06', 'upcoming'), ['slot-1', 'slot-3'])
  assert.deepEqual(ids('2026-12-06', 'day'), ['slot-3'])
  assert.deepEqual(ids('2026-12-06', 'upcoming'), ['slot-3'])
})

test('whatever appears under "day" also appears under "upcoming" for the same date', () => {
  const slots: DashboardSlot[] = []
  // Every half hour around two days in summer time and two in winter time (including the clock changes).
  for (const day of ['2026-03-28', '2026-03-29', '2026-07-14', '2026-10-24', '2026-10-25', '2026-12-05']) {
    for (let minutes = 0; minutes < 48 * 60; minutes += 30) {
      const start = new Date(`${day}T00:00:00Z`).getTime() + minutes * 60_000
      slots.push(slot(slots.length + 1, { start_datetime: new Date(start).toISOString().slice(0, 19).replace('T', ' ') }))
    }
  }
  const list = buildAppointments(data(slots, []), BASE)
  const dates = new Set(list.map((a) => a.visitDate))
  for (const date of dates) {
    const day = new Set(list.filter((a) => inScope(a, date, 'day')).map((a) => a.id))
    const upcoming = new Set(list.filter((a) => inScope(a, date, 'upcoming')).map((a) => a.id))
    assert.ok(day.size > 0)
    for (const id of day) assert.ok(upcoming.has(id), `${id} is in "day" but not in "upcoming" for ${date}`)
    for (const a of list) assert.equal(upcoming.has(a.id), a.visitDate >= date, `${a.id} on ${date}`)
  }
})

test('the technician filter keeps appointments of that person only, selected by id', () => {
  const list = buildAppointments(
    data([slot(1, { employee_ids: [[7, 'Jan']] }), slot(2, { employee_ids: [[8, 'Sanne']] })], []),
    BASE,
  )
  assert.deepEqual(filterByTechnician(list, 'employee:8').map((a) => a.id), ['slot-2'])
  assert.deepEqual(filterByTechnician(list, 'Sanne'), [], 'a name is no longer a valid selection')
  assert.equal(filterByTechnician(list, '').length, 2)
})

test('two different people with the same name stay separate: separate choices, separate results', () => {
  const list = buildAppointments(
    data(
      [
        slot(1, { employee_ids: [[7, 'Piet Smit']], user_ids: [[21, 'Piet Smit']] }),
        slot(2, { employee_ids: [[9, 'Piet Smit']], user_ids: [[22, 'Piet Smit']] }),
        slot(3, { employee_ids: [[8, 'Sanne Bakker']] }),
      ],
      [],
    ),
    BASE,
  )
  assert.deepEqual(technicianOptions(list), [
    { value: 'employee:7', label: 'Piet Smit (medewerker 7)' },
    { value: 'employee:9', label: 'Piet Smit (medewerker 9)' },
    { value: 'employee:8', label: 'Sanne Bakker' },
  ])
  assert.deepEqual(filterByTechnician(list, 'employee:7').map((a) => a.id), ['slot-1'])
  assert.deepEqual(filterByTechnician(list, 'employee:9').map((a) => a.id), ['slot-2'])
})

test('technician options: unique, sorted by name, a suffix only where names collide', () => {
  const list = buildAppointments(
    data(
      [
        slot(1, { employee_ids: [[8, 'Sanne']] }),
        slot(2, { employee_ids: [[8, 'Sanne'], [7, 'Jan']] }),
        slot(3, { employee_ids: [], user_ids: [[3, 'Jan']] }),
      ],
      [],
    ),
    BASE,
  )
  // Jan the employee and Jan the user were never seen together, so they cannot be proven to be one person.
  assert.deepEqual(technicianOptions(list), [
    { value: 'user:3', label: 'Jan (gebruiker 3)' },
    { value: 'employee:7', label: 'Jan (medewerker 7)' },
    { value: 'employee:8', label: 'Sanne' },
  ])
})

test('a user seen together with an employee elsewhere is the same person everywhere, also as technician of a visit', () => {
  const list = buildAppointments(
    data(
      [
        slot(1, { employee_ids: [[7, 'Jan']], user_ids: [[5, 'Jan']] }),
        slot(2, { employee_ids: [], user_ids: [[5, 'Jan']] }),
      ],
      [visit(100, { technician_id: [5, 'Jan'] })],
    ),
    BASE,
  )
  assert.deepEqual(list.map((a) => a.people), [
    [{ id: 'employee:7', name: 'Jan' }],
    [{ id: 'employee:7', name: 'Jan' }],
    [{ id: 'employee:7', name: 'Jan' }],
  ])
  assert.deepEqual(technicianOptions(list), [{ value: 'employee:7', label: 'Jan' }])
  assert.equal(filterByTechnician(list, 'employee:7').length, 3)
})

test('an ambiguous name match does not link a user to an employee', () => {
  // Two employees called Jan and one user called Jan in the same slot: there is no telling which is which.
  const [slotAppointment] = buildAppointments(
    data([slot(1, { employee_ids: [[7, 'Jan'], [9, 'Jan']], user_ids: [[5, 'Jan']] })], []),
    BASE,
  )
  assert.deepEqual(slotAppointment.people.map((p) => p.id), ['employee:7', 'employee:9', 'user:5'])
  // The same user matching two different employees in two slots is ambiguous as well.
  const list = buildAppointments(
    data(
      [
        slot(1, { employee_ids: [[7, 'Jan']], user_ids: [[5, 'Jan']] }),
        slot(2, { employee_ids: [[9, 'Jan']], user_ids: [[5, 'Jan']] }),
      ],
      [],
    ),
    BASE,
  )
  assert.deepEqual(list.map((a) => a.people.map((p) => p.id)), [['employee:7', 'user:5'], ['employee:9', 'user:5']])
})

test('assignees without a name or with a plain id still get a stable id', () => {
  const [appointment] = buildAppointments(
    data(
      [
        slot(1, {
          // Odoo can send a many2many as a list of plain ids, or as records.
          employee_ids: [4, { id: 6, display_name: 'Els' }] as unknown as DashboardSlot['employee_ids'],
          user_ids: [] as DashboardSlot['user_ids'],
        }),
      ],
      [],
    ),
    BASE,
  )
  assert.deepEqual(appointment.people, [
    { id: 'employee:4', name: 'Medewerker 4' },
    { id: 'employee:6', name: 'Els' },
  ])
  assert.equal(appointment.assigned, true)
})

test('the status of an appointment is that of its first unfinished visit, done only when all are done', () => {
  const state = (visits: Array<[number, string]>, slotState = 'published') =>
    buildAppointments(data([slot(1, { state: slotState })], visits.map(([id, s]) => visit(id, { slot_id: [1, 'Slot 1'], state: s }))), BASE)[0].state
  assert.equal(state([[100, 'done'], [101, 'in_progress']]), 'in_progress')
  assert.equal(state([[100, 'in_progress'], [101, 'done']]), 'in_progress')
  assert.equal(state([[100, 'done'], [101, 'draft'], [102, 'in_progress']]), 'draft')
  assert.equal(state([[100, 'done'], [101, 'done']]), 'done')
  assert.equal(state([[100, 'in_progress']]), 'in_progress')
  assert.equal(state([], 'published'), 'published')
  assert.equal(appointmentState([]), undefined)
})

test('every visit appears exactly once on screen, whatever the links between slots and visits look like', () => {
  // Seeded pseudo-random datasets: visits without a slot, pointing at a slot that was not loaded, listed by
  // several slots, listed but not loaded, and duplicated records.
  let seed = 42
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  for (let round = 0; round < 3000; round++) {
    const slotIds = Array.from({ length: Math.floor(random() * 4) }, (_, i) => i + 1)
    const visitIds = Array.from({ length: Math.floor(random() * 6) }, (_, i) => 100 + i)
    const pickSlot = (): number | false =>
      slotIds.length && random() < 0.8 ? slotIds[Math.floor(random() * slotIds.length)] : random() < 0.5 ? 99 : false
    const visits = visitIds.flatMap((id) => {
      const own = (): DashboardVisit => {
        const slotId = pickSlot()
        return visit(id, { slot_id: slotId === false ? false : [slotId, 'Slot'] })
      }
      return random() < 0.15 ? [own(), own()] : [own()]
    })
    const slots = slotIds.map((id) => slot(id, { svs_tech_visit_ids: visitIds.filter(() => random() < 0.3).concat(random() < 0.1 ? [555] : []) }))
    const shown = buildAppointments(data(slots, visits), BASE).flatMap((a) => a.visits.map((v) => v.id)).sort()
    assert.deepEqual(shown, [...new Set(visitIds)].sort(), JSON.stringify({ slots: slots.map((s) => [s.id, s.svs_tech_visit_ids]), visits: visits.map((v) => [v.id, v.slot_id]) }))
  }
})
