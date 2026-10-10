import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAppointments } from '../src/lib/appointments.ts'
import { canManageAccounts, canRefresh, technicianChoicesFor, visibleAppointments } from '../src/lib/authorization.ts'
import type { User } from '../src/lib/authorization.ts'
import type { DashboardSlot, DashboardVisit } from '../src/lib/dashboard-types.ts'

const BASE = 'https://odoo.example'

function slot(id: number, overrides: Partial<DashboardSlot> = {}): DashboardSlot {
  return {
    id, name: `Slot ${id}`, start_datetime: '2026-10-05 07:00:00', end_datetime: '2026-10-05 09:00:00', allocated_hours: 2,
    role_id: [1, 'Monteur'], user_ids: [], employee_ids: [], partner_id: [10, 'Klant'], partner_name: `Klant ${id}`,
    partner_address: 'Straat 1', sale_order_id: false, sale_line_id: false, state: 'published', svs_tech_visit_ids: [],
    travel_time_in: 10, travel_time_out: 10, travel_times_up_to_date: true, ...overrides,
  }
}

function visit(id: number, overrides: Partial<DashboardVisit> = {}): DashboardVisit {
  return {
    id, name: `TV/${id}`, state: 'in_progress', visit_date: '2026-10-05', partner_id: [10, 'Klant'], technician_id: false,
    template_id: [1, 'Sjabloon'], slot_id: false, task_id: false, is_complete: false, is_sent: false,
    missing_required_count: 1, missing_required_inputs_count: 1, photo_count: 2, photo_ids: [], notes: '', ...overrides,
  }
}

const admin: User = { id: 'u_admin', username: 'beheer', name: 'Beheer', role: 'admin', personId: null, emergency: false }
const monteur = (personId: string | null): User => ({ id: 'u_m', username: 'jan', name: 'Jan', role: 'monteur', personId, emergency: false })

function appointments() {
  return buildAppointments(
    {
      company: { id: 2, name: 'Test' },
      slots: [
        slot(1, { employee_ids: [[7, 'Jan']], user_ids: [[5, 'Jan']], svs_tech_visit_ids: [100] }),
        slot(2, { employee_ids: [[8, 'Sanne']], user_ids: [[6, 'Sanne']] }),
        slot(3, { employee_ids: [[7, 'Jan'], [8, 'Sanne']] }),
        slot(4, { employee_ids: [] }),
        slot(5, { employee_ids: [], user_ids: [[5, 'Jan']] }),
      ],
      visits: [
        visit(100, { slot_id: [1, 'Slot 1'], technician_id: [5, 'Jan'] }),
        visit(101, { technician_id: [5, 'Jan'] }), // not scheduled, Jan's
        visit(102, { technician_id: [6, 'Sanne'] }), // not scheduled, Sanne's
        visit(103), // not scheduled, nobody's
      ],
      truncated: false,
      loadedAt: '2026-10-05T00:00:00Z',
    },
    BASE,
  )
}

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id).sort()

test('an admin sees every appointment, with the links to Odoo', () => {
  const all = appointments()
  const seen = visibleAppointments(admin, all)
  assert.equal(seen.length, all.length)
  assert.ok(seen.some((a) => a.odooUrl?.startsWith(BASE)))
  assert.ok(seen.flatMap((a) => a.visits).every((v) => v.odooUrl?.startsWith(BASE)))
})

test('a technician sees only the appointments of the person their account is linked to', () => {
  const seen = visibleAppointments(monteur('employee:7'), appointments())
  assert.deepEqual(ids(seen), ['slot-1', 'slot-3', 'slot-5', 'visit-101'])
})

test('a technician also sees appointments they share with a colleague, and nobody else\'s', () => {
  const seen = visibleAppointments(monteur('employee:8'), appointments())
  assert.deepEqual(ids(seen), ['slot-2', 'slot-3', 'visit-102'])
  assert.ok(!seen.some((a) => a.id === 'slot-1' || a.id === 'visit-101' || a.id === 'visit-103' || a.id === 'slot-4'))
})

test('an account linked with an older id of the person still finds them', () => {
  assert.deepEqual(ids(visibleAppointments(monteur('user:5'), appointments())), ids(visibleAppointments(monteur('employee:7'), appointments())))
})

test('a technician without a person, or with a person nobody is planned as, sees nothing and not everything', () => {
  assert.deepEqual(visibleAppointments(monteur(null), appointments()), [])
  assert.deepEqual(visibleAppointments(monteur('employee:999'), appointments()), [])
  assert.deepEqual(visibleAppointments(monteur(''), appointments()), [])
})

test('a technician gets no link to Odoo, on the appointment or on a visit (they have no Odoo account)', () => {
  const seen = visibleAppointments(monteur('employee:7'), appointments())
  assert.ok(seen.length > 0)
  for (const appointment of seen) {
    assert.equal(appointment.odooUrl, null, appointment.id)
    for (const v of appointment.visits) assert.equal(v.odooUrl, null, `${appointment.id} ${v.id}`)
  }
  assert.ok(!JSON.stringify(seen).includes(BASE), 'the address of Odoo is nowhere in the answer')
})

test('hiding the links does not change the data the admin gets from the same list', () => {
  const all = appointments()
  const before = JSON.stringify(all)
  visibleAppointments(monteur('employee:7'), all)
  assert.equal(JSON.stringify(all), before)
})

test('a visit technician that the planning never lists with an employee is a person of their own: not a colleague\'s', () => {
  // No slot lists Piet's user (9) next to an employee, so nothing says user 9 is employee 10.
  const list = buildAppointments(
    {
      company: { id: 2, name: 'Test' },
      slots: [slot(1, { employee_ids: [[10, 'Piet']] })],
      visits: [visit(200, { technician_id: [9, 'Piet'] })],
      truncated: false,
      loadedAt: '2026-10-05T00:00:00Z',
    },
    BASE,
  )
  assert.deepEqual(ids(visibleAppointments(monteur('employee:10'), list)), ['slot-1'])
  assert.deepEqual(ids(visibleAppointments(monteur('user:9'), list)), ['visit-200'])
})

test('a technician still sees what the work needs: customer, address, colleagues and the form status', () => {
  const [first] = visibleAppointments(monteur('employee:7'), appointments())
  assert.equal(first.customer, 'Klant 1')
  assert.equal(first.address, 'Straat 1')
  assert.ok(first.people.length > 0)
  assert.equal(first.visits[0].missingRequired, 1)
})

test('only an admin may refresh from Odoo and manage accounts', () => {
  assert.equal(canRefresh(admin), true)
  assert.equal(canManageAccounts(admin), true)
  assert.equal(canRefresh(monteur('employee:7')), false)
  assert.equal(canManageAccounts(monteur('employee:7')), false)
})

test('the technician filter choices are for admins; a technician gets none', () => {
  const all = appointments()
  assert.deepEqual(technicianChoicesFor(admin, all).map((choice) => choice.value), ['employee:7', 'employee:8'])
  assert.deepEqual(technicianChoicesFor(monteur('employee:7'), all), [])
})
