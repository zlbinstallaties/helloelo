import test from 'node:test'
import assert from 'node:assert/strict'
import { amsterdamDate, buildAppointments, filterByTechnician, inScope } from '../src/lib/appointments.ts'
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
  return { company: { id: 2, name: 'Test' }, slots, visits, loadedAt: '2026-10-05T00:00:00Z' }
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
  assert.equal(list[0].people[0], 'Jan')
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

test('people are the unique names of employees and users', () => {
  const [appointment] = buildAppointments(
    data([slot(1, { employee_ids: [[7, 'Jan'], [8, 'Sanne']], user_ids: [[5, 'Jan']] })], []),
    BASE,
  )
  assert.deepEqual(appointment.people, ['Jan', 'Sanne'])
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

test('the technician filter keeps appointments of that person only', () => {
  const list = buildAppointments(
    data([slot(1, { employee_ids: [[7, 'Jan']] }), slot(2, { employee_ids: [[8, 'Sanne']] })], []),
    BASE,
  )
  assert.deepEqual(filterByTechnician(list, 'Sanne').map((a) => a.id), ['slot-2'])
  assert.equal(filterByTechnician(list, '').length, 2)
})
