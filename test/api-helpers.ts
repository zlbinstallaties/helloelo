import { createAccountStore } from '../src/lib/accounts.ts'
import type { AccountIo } from '../src/lib/accounts.ts'
import { createAuth } from '../src/lib/auth.ts'
import { createAvailabilityStore } from '../src/lib/availability.ts'
import { createDocumentJournal } from '../src/lib/document-journal.ts'
import { createJournal } from '../src/lib/employee-journal.ts'
import type { PostDocumentOutcome } from '../src/lib/gateway-document.ts'
import type { AddUnavailabilityOutcome, EmployeeRolesOutcome, GatewayOutcome, PlanningRolesOutcome, RemoveUnavailabilityOutcome, SetRolesOutcome } from '../src/lib/gateway-employee.ts'
import { createHandlers } from '../src/lib/handlers.ts'
import { hashPassword } from '../src/lib/password.ts'
import { createLoginLimiter, createSessions } from '../src/lib/sessions.ts'
import type { DashboardData, DashboardSlot, DashboardVisit } from '../src/lib/dashboard-types.ts'

/* Shared set-up of the handler tests: a complete dashboard with in-memory files and mocks for Odoo. */

export const SECRET = 'a-secret-of-at-least-thirty-two-bytes!'
export const PASSWORD = 'een-goed-wachtwoord'
export const EMERGENCY_PASSWORD = 'noodwachtwoord-van-de-server'
export const ODOO = 'https://odoo.example'

export function slot(id: number, overrides: Partial<DashboardSlot> = {}): DashboardSlot {
  return {
    id, name: `Slot ${id}`, start_datetime: '2026-10-05 07:00:00', end_datetime: '2026-10-05 09:00:00', allocated_hours: 2,
    role_id: [1, 'Monteur'], user_ids: [], employee_ids: [], partner_id: [10, 'Klant'], partner_name: `Klant ${id}`,
    partner_address: 'Straat 1', sale_order_id: false, sale_line_id: false, state: 'published', svs_tech_visit_ids: [],
    travel_time_in: 10, travel_time_out: 10, travel_times_up_to_date: true, ...overrides,
  }
}

export function visit(id: number, overrides: Partial<DashboardVisit> = {}): DashboardVisit {
  return {
    id, name: `TV/${id}`, state: 'in_progress', visit_date: '2026-10-05', partner_id: [10, 'Klant'], technician_id: false,
    template_id: [1, 'Sjabloon'], slot_id: false, task_id: false, is_complete: false, is_sent: false,
    missing_required_count: 1, missing_required_inputs_count: 1, photo_count: 2, photo_ids: [], notes: '', ...overrides,
  }
}

export const DATA: DashboardData = {
  company: { id: 2, name: 'Test BV' },
  slots: [
    slot(1, { employee_ids: [[7, 'Jan']], svs_tech_visit_ids: [100] }),
    slot(2, { employee_ids: [[8, 'Sanne']] }),
    slot(3, { employee_ids: [[7, 'Jan'], [8, 'Sanne']] }),
    slot(4, { start_datetime: '2026-10-06 07:00:00', employee_ids: [[8, 'Sanne']] }),
  ],
  visits: [visit(100, { slot_id: [1, 'Slot 1'] }), visit(101)],
  truncated: false,
  loadedAt: '2026-10-05T00:00:00.000Z',
}

export const GENERATED = 'Tijd-Elijk-Pass-Word'

export function setup(options: { mode?: 'on' | 'off'; configured?: boolean; secure?: boolean; createEmployee?: (input: { requestId: string; name: string; planningRoleIds?: readonly number[] }) => Promise<GatewayOutcome>; listPlanningRoles?: () => Promise<PlanningRolesOutcome>; getEmployeeRoles?: (employeeId: number) => Promise<EmployeeRolesOutcome>; setEmployeeRoles?: (employeeId: number, planningRoleIds: readonly number[]) => Promise<SetRolesOutcome> } = {}) {
  const state = { text: null as string | null }
  const io: AccountIo = { read: () => state.text, write: (text) => (state.text = text) }
  const journalState = { text: null as string | null }
  const journalIo: AccountIo = { read: () => journalState.text, write: (text) => (journalState.text = text) }
  const availabilityState = { text: null as string | null }
  const availabilityIo: AccountIo = { read: () => availabilityState.text, write: (text) => (availabilityState.text = text) }
  // The day of the availability tests: Wednesday 7 October 2026.
  const availabilityClock = { now: new Date('2026-10-07T10:00:00Z') }
  const availability = createAvailabilityStore({ io: availabilityIo, now: () => availabilityClock.now })
  const accounts = createAccountStore({ io, reservedUsernames: ['noodadmin'] })
  const journal = createJournal({ io: journalIo })
  const documentState = { text: null as string | null }
  const documentIo: AccountIo = { read: () => documentState.text, write: (text) => (documentState.text = text) }
  // The day of the document tests: Thursday 8 October 2026, 11:30 in Amsterdam.
  const documentClock = { now: new Date('2026-10-08T09:30:00Z') }
  const documents = createDocumentJournal({ io: documentIo, now: () => documentClock.now })
  const clock = { now: 1_000_000 }
  const auth = createAuth({
    accounts,
    sessions: createSessions({ secret: SECRET, now: () => clock.now }),
    limiter: createLoginLimiter({ max: 4, now: () => clock.now }),
    emergency: { username: 'noodadmin', passwordHash: hashPassword(EMERGENCY_PASSWORD) },
  })
  const loads: boolean[] = []
  const control = { failWith: null as Error | null, /** Other planning data than DATA, for a test that needs it. */ data: null as DashboardData | null }
  // What the dashboard sends to Odoo (through the gateway), and what Odoo answers. Nothing here is a real Odoo.
  const odoo = {
    calls: [] as Array<{ requestId: string; name: string; planningRoleIds?: readonly number[] }>,
    /** What the gateway says the planning roles are. */
    roles: (): PlanningRolesOutcome | Promise<PlanningRolesOutcome> => ({ ok: true, roles: [{ id: 3, name: 'Monteur' }, { id: 4, name: 'Planner' }] }),
    roleCalls: 0,
    /** What the gateway says one employee has now, and what it answers to a change. */
    employeeRoles: (): EmployeeRolesOutcome | Promise<EmployeeRolesOutcome> => ({ ok: true, planningRoleIds: [3, 4], defaultPlanningRoleId: 3 }),
    setRolesAnswer: (): SetRolesOutcome | Promise<SetRolesOutcome> => ({ ok: true, planningRoles: 2, asked: 2 }),
    reads: [] as number[],
    /** What the gateway is asked about marking an employee as not available, and what it answers. */
    away: {
      adds: [] as Array<{ requestId: string; employeeId: number; from: string; to: string; note: string }>,
      removes: [] as Array<{ employeeId: number; leaveId: number }>,
      addAnswer: (): AddUnavailabilityOutcome | Promise<AddUnavailabilityOutcome> => ({ ok: true, leaveId: 901, verified: true }),
      removeAnswer: (): RemoveUnavailabilityOutcome | Promise<RemoveUnavailabilityOutcome> => ({ ok: true, removed: true }),
    },
    sets: [] as Array<{ employeeId: number; planningRoleIds: readonly number[] }>,
    /** What the gateway is asked about a document, and what it answers. Nothing here is a real Odoo. */
    docs: {
      posts: [] as Array<{ requestId: string; reference: { model: string; id: number }; filename: string; summary: string; pdf: Uint8Array }>,
      answer: (): PostDocumentOutcome | Promise<PostDocumentOutcome> => ({ ok: true, noted: true, customer: 'Klant van Odoo', replayed: false }),
    },
    outcome: (): GatewayOutcome | Promise<GatewayOutcome> => ({ kind: 'created', id: 41, verified: true, planningRoles: 0, replayed: false }),
  }
  const mode = options.mode ?? 'on'
  const configured = options.configured ?? true
  const on = mode === 'on' && configured
  const handlers = createHandlers({
    authMode: mode,
    auth: on ? auth : null,
    accounts: on ? accounts : null,
    journal: on ? journal : null,
    availability: on ? availability : null,
    documents: on ? documents : null,
    now: () => documentClock.now,
    secureCookies: options.secure ?? true,
    clientAddress: (request) => request.headers.get('x-test-ip') ?? '10.0.0.1',
    loadData: async (refresh) => {
      loads.push(refresh)
      if (control.failWith) throw control.failWith
      return control.data ?? DATA
    },
    odooBaseUrl: ODOO,
    createEmployee:
      options.createEmployee ??
      (async (input) => {
        odoo.calls.push(input)
        return odoo.outcome()
      }),
    listPlanningRoles:
      options.listPlanningRoles ??
      (async () => {
        odoo.roleCalls += 1
        return odoo.roles()
      }),
    getEmployeeRoles:
      options.getEmployeeRoles ??
      (async (employeeId: number) => {
        odoo.reads.push(employeeId)
        return odoo.employeeRoles()
      }),
    setEmployeeRoles:
      options.setEmployeeRoles ??
      (async (employeeId: number, planningRoleIds: readonly number[]) => {
        odoo.sets.push({ employeeId, planningRoleIds })
        return odoo.setRolesAnswer()
      }),
    addUnavailability: async (input) => {
      odoo.away.adds.push(input)
      return odoo.away.addAnswer()
    },
    removeUnavailability: async (input) => {
      odoo.away.removes.push(input)
      return odoo.away.removeAnswer()
    },
    postDocument: async (input) => {
      odoo.docs.posts.push(input)
      return odoo.docs.answer()
    },
    generatePassword: () => GENERATED,
  })
  accounts.create({ username: 'jan', name: 'Jan de Vries', role: 'monteur', personId: 'employee:7', password: PASSWORD })
  accounts.create({ username: 'planner', name: 'Petra Planner', role: 'admin', personId: null, password: PASSWORD })
  return { handlers, accounts, auth, journal, availability, availabilityState, availabilityClock, documents, documentState, documentClock, loads, control, state, journalState, clock, odoo }
}

export type Api = ReturnType<typeof setup>

export function request(path: string, init: { method?: string; cookie?: string; body?: unknown; csrf?: boolean; ip?: string } = {}) {
  const method = init.method ?? 'GET'
  const headers = new Headers()
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.csrf !== false && method !== 'GET') headers.set('x-dig-dashboard', '1')
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.ip) headers.set('x-test-ip', init.ip)
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  return new Request(`http://dash.test${path}`, { method, headers, body })
}

export async function read(response: Response) {
  const text = await response.text()
  return { status: response.status, headers: response.headers, text, json: text ? (JSON.parse(text) as Record<string, any>) : {} }
}

export async function login(api: Api, username: string, password = PASSWORD, ip?: string) {
  const response = await api.handlers.login(request('/api/auth/login', { method: 'POST', body: { username, password }, ip }))
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  return { response, cookie: cookie && cookie.includes('=') && !cookie.endsWith('=') ? cookie : undefined }
}

export async function dashboard(api: Api, cookie?: string, query = '') {
  return read(await api.handlers.dashboardGet(request(`/api/dashboard${query}`, { cookie })))
}

export const ids = (list: Array<{ id: string }>) => list.map((item) => item.id).sort()

