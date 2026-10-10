import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OdooError, OdooWriteError, type OdooClient } from '../../src/lib/odoo-client.ts'
import { parseProjects, sha256Hex } from '../src/projects.ts'
import { createGateway, type AccessLogEntry } from '../src/server.ts'

const TOKEN = 'writer-token-123'
const READER = 'reader-token-456'
const LIMITED = 'limited-token-789'
const ROLEWRITER = 'rolewriter-token-321'
const ROLEONLY = 'roleonly-token-654'
const REQUEST = 'req-0123456789abcdef'
const NOW = Date.UTC(2026, 9, 6, 10, 0)

const projects = parseProjects({
  projects: [
    {
      id: 'dashboard-live',
      tokenSha256: sha256Hex(TOKEN),
      companyId: 2,
      models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } },
      actions: { createEmployee: { responsibleUserId: 9, maxPerHour: 3 } },
    },
    {
      id: 'dashboard-limited',
      tokenSha256: sha256Hex(LIMITED),
      companyId: 2,
      models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } },
      actions: { createEmployee: { responsibleUserId: 9, allowedPlanningRoleIds: [3, 4] } },
    },
    {
      id: 'dashboard-roles',
      tokenSha256: sha256Hex(ROLEWRITER),
      companyId: 2,
      models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } },
      actions: { createEmployee: { responsibleUserId: 9 }, setEmployeePlanningRoles: { maxPerHour: 3, allowedPlanningRoleIds: [3, 4] } },
    },
    {
      id: 'roles-only',
      tokenSha256: sha256Hex(ROLEONLY),
      companyId: 2,
      models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } },
      actions: { setEmployeePlanningRoles: {} },
    },
    {
      id: 'preview',
      tokenSha256: sha256Hex(READER),
      companyId: 2,
      models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } },
    },
  ],
})

type Call = { method: string; params: unknown }
type Check = Awaited<ReturnType<OdooClient['checkResponsible']>>
const GOOD: Check = { exists: true, active: true, internal: true, inCompany: true }

function fakeOdoo(overrides: Partial<OdooClient> = {}) {
  const calls: Call[] = []
  let lastName = ''
  let lastRoles: readonly number[] = []
  const odoo: OdooClient = {
    async searchRead() {
      calls.push({ method: 'search_read', params: null })
      return []
    },
    async searchCount() {
      return 0
    },
    async fieldsGet() {
      return {}
    },
    async checkResponsible(params) {
      calls.push({ method: 'checkResponsible', params })
      return GOOD
    },
    async setEmployeePlanningRoles(params) {
      calls.push({ method: 'setEmployeePlanningRoles', params })
      lastRoles = params.planningRoleIds
    },
    async listPlanningRoles(params) {
      calls.push({ method: 'listPlanningRoles', params })
      return [{ id: 3, name: 'Monteur' }, { id: 4, name: 'Planner' }, { id: 5, name: 'Ploegbaas' }]
    },
    async checkPlanningRoles(params) {
      calls.push({ method: 'checkPlanningRoles', params })
      return [...params.ids]
    },
    async createEmployee(params) {
      calls.push({ method: 'createEmployee', params })
      lastName = params.name
      lastRoles = params.planningRoleIds ?? []
      return 41
    },
    async readEmployee(params) {
      calls.push({ method: 'readEmployee', params })
      return { id: params.id, name: lastName, companyId: params.companyId, planningRoleIds: params.planningRoles ? [...lastRoles] : null, defaultPlanningRoleId: params.planningRoles ? (lastRoles[0] ?? null) : null, userId: null, userLinked: false, active: true, resourceId: null, resourceCalendarId: null, tz: null }
    },
    async createUnavailability() {
      throw new Error('unexpected call: createUnavailability')
    },
    async readUnavailability() {
      throw new Error('unexpected call: readUnavailability')
    },
    async removeUnavailability() {
      throw new Error('unexpected call: removeUnavailability')
    },
    async readReferencePartner() {
      throw new Error('unexpected call: readReferencePartner')
    },
    async postDocument() {
      throw new Error('unexpected call: postDocument')
    },
    ...overrides,
  }
  const count = (method: string) => calls.filter((call) => call.method === method).length
  return { odoo, calls, count }
}

async function start(odoo: OdooClient, options: { logs?: AccessLogEntry[]; now?: () => number } = {}) {
  const server: Server = createServer(createGateway({ projects, odoo, log: (e) => options.logs?.push(e), now: options.now ?? (() => NOW) }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    async create(body: unknown, init: { token?: string | null; method?: string; path?: string } = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`
      const response = await fetch(base + (init.path ?? '/v1/actions/create_employee'), {
        method: init.method ?? 'POST',
        headers,
        body: init.method === 'GET' ? undefined : JSON.stringify(body),
      })
      return { status: response.status, json: (await response.json()) as Record<string, any> }
    },
  }
}

async function withGateway(odoo: OdooClient, run: (gw: Awaited<ReturnType<typeof start>>) => Promise<void>, options: Parameters<typeof start>[1] = {}) {
  const gw = await start(odoo, options)
  try {
    await run(gw)
  } finally {
    await gw.close()
  }
}

const body = (overrides: Record<string, unknown> = {}) => ({ requestId: REQUEST, name: 'Jan de Vries', ...overrides })

test('a project without the action cannot create an employee, and Odoo is not called', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const response = await gw.create(body(), { token: READER })
    assert.equal(response.status, 403)
    assert.equal(response.json.error, 'action_not_allowed')
    assert.equal(calls.length, 0)
  })
})

test('no token or a wrong token: 401, and Odoo is not called', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.create(body(), { token: null })).status, 401)
    assert.equal((await gw.create(body(), { token: 'nope' })).status, 401)
    assert.equal(calls.length, 0)
  })
})

test('only POST on the one action address; other actions and generic writes do not exist', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.create(body(), { method: 'GET' })).status, 405)
    for (const path of ['/v1/actions/create_user', '/v1/actions/create', '/v1/actions/', '/v1/models/hr.employee/create', '/v1/models/hr.employee/write', '/v1/actions/create_employee/x']) {
      assert.equal((await gw.create(body(), { path })).status, 404, path)
    }
    assert.equal(calls.length, 0)
  })
})

test('a creation checks the responsible, creates one employee with the fixed values, and reads it back', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const response = await gw.create(body())
    assert.equal(response.status, 200)
    assert.deepEqual(response.json, { id: 41, name: 'Jan de Vries', verified: true, planningRoles: 0 })
    assert.deepEqual(calls.map((call) => call.method), ['checkResponsible', 'createEmployee', 'readEmployee'], 'no roles configured: no role check')
    assert.deepEqual(calls[0].params, { userId: 9, companyId: 2 })
    assert.deepEqual(calls[1].params, { name: 'Jan de Vries', companyId: 2, responsibleUserId: 9, dateVersion: '2026-10-06', planningRoleIds: [], defaultPlanningRoleId: null })
    assert.deepEqual(calls[2].params, { id: 41, companyId: 2, planningRoles: false })
  })
})

test('the start date is the Amsterdam date, also just after midnight there', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    await gw.create(body())
  }, { now: () => Date.UTC(2026, 9, 5, 23, 30) })
  const created = calls.find((call) => call.method === 'createEmployee')
  assert.equal((created?.params as { dateVersion: string } | undefined)?.dateVersion, '2026-10-06')
})

test('the request cannot choose company, responsible, user, model, method or values', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (const extra of [
      { companyId: 3 }, { company_id: 3 }, { responsibleUserId: 5 }, { hr_responsible_id: 5 }, { responsible: 5 },
      { userId: 5 }, { user_id: 5 }, { model: 'res.users' }, { method: 'write' }, { vals: { user_id: 5 } },
      { date_version: '2020-01-01' }, { dateVersion: '2020-01-01' }, { active: false }, { groups_id: [1] },
    ]) {
      const response = await gw.create(body(extra))
      assert.equal(response.status, 400, JSON.stringify(extra))
      assert.equal(response.json.error, 'unknown_parameter', JSON.stringify(extra))
    }
    assert.equal(calls.length, 0)
  })
})

test('the name and the request id are checked before Odoo is called', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (const name of [undefined, '', '   ', 'x'.repeat(81), 'Jan\nde Vries', 'Jan\u0000', 5, ['Jan'], { a: 1 }, null]) {
      const response = await gw.create(body({ name }))
      assert.equal(response.status, 400, String(name))
      assert.equal(response.json.error, 'invalid_name', String(name))
    }
    for (const requestId of [undefined, '', 'kort', 'x'.repeat(65), 'met spatie 0123456789', 'a/b/c/d/e/f/g/h/i/j', 5, null]) {
      const response = await gw.create(body({ requestId }))
      assert.equal(response.status, 400, String(requestId))
      assert.equal(response.json.error, 'invalid_request_id', String(requestId))
    }
    assert.equal(calls.length, 0)
  })
})

test('a responsible who does not qualify stops the creation: nothing is created, and fixing it makes a retry work', async () => {
  for (const check of [
    { exists: false, active: false, internal: false, inCompany: false },
    { ...GOOD, active: false },
    { ...GOOD, internal: false },
    { ...GOOD, inCompany: false },
  ]) {
    let answer: Check = check
    const { odoo, count } = fakeOdoo({ async checkResponsible() { return answer } })
    await withGateway(odoo, async (gw) => {
      const refused = await gw.create(body())
      assert.equal(refused.status, 409, JSON.stringify(check))
      assert.equal(refused.json.error, 'responsible_not_allowed')
      assert.equal(count('createEmployee'), 0)
      answer = GOOD
      assert.equal((await gw.create(body())).status, 200, 'the same request works once the responsible is right')
      assert.equal(count('createEmployee'), 1)
    })
  }
})

test('Odoo refuses the creation: an error, nothing is remembered as created, and the same request may be repeated', async () => {
  let refuse = true
  const { odoo, count } = fakeOdoo({
    async createEmployee() {
      if (refuse) throw new OdooWriteError('Odoo hr.employee write failed (403)', 403, 'rejected', 'odoo.exceptions.AccessError')
      return 41
    },
  })
  await withGateway(odoo, async (gw) => {
    const refused = await gw.create(body())
    assert.equal(refused.status, 502)
    assert.equal(refused.json.error, 'odoo_rejected')
    assert.ok(!JSON.stringify(refused.json).includes('Access denied'))
    refuse = false
    const retry = await gw.create(body())
    assert.equal(retry.status, 200)
    assert.equal(retry.json.replayed, undefined, 'a refused request leaves nothing to replay')
    assert.equal(count('readEmployee'), 1)
  })
})

test('an unknown outcome blocks a repeat of the same request, so a second employee cannot appear', async () => {
  let creates = 0
  const { odoo } = fakeOdoo({
    async createEmployee() {
      creates += 1
      throw new OdooWriteError('Odoo hr.employee write timed out', 0, 'unknown')
    },
  })
  await withGateway(odoo, async (gw) => {
    const first = await gw.create(body())
    assert.equal(first.status, 504)
    assert.equal(first.json.error, 'outcome_unknown')
    for (let i = 0; i < 3; i++) {
      const again = await gw.create(body())
      assert.equal(again.status, 409)
      assert.equal(again.json.error, 'outcome_unknown')
    }
    assert.equal(creates, 1, 'Odoo was asked once')
    const other = await gw.create(body({ requestId: 'req-another-0123456789' }))
    assert.equal(other.status, 504, 'a new request id is a new decision of the caller')
    assert.equal(creates, 2)
  })
})

test('an error while checking the responsible creates nothing and is not remembered', async () => {
  let fail = true
  const { odoo, count } = fakeOdoo({
    async checkResponsible() {
      if (fail) throw new OdooError('Odoo res.users read timed out', 0)
      return GOOD
    },
  })
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.create(body())).status, 504)
    assert.equal(count('createEmployee'), 0)
    fail = false
    assert.equal((await gw.create(body())).status, 200)
  })
})

test('repeating a finished request gives the same answer and creates nothing', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const first = await gw.create(body())
    const again = await gw.create(body())
    const third = await gw.create(body({ name: '  Jan de Vries  ' }))
    assert.equal(first.status, 200)
    assert.deepEqual(again.json, { ...first.json, replayed: true })
    assert.deepEqual(third.json, { ...first.json, replayed: true }, 'spaces around the name are not a different request')
    assert.equal(count('createEmployee'), 1)
  })
})

test('the same request id with another name is refused: it is not a repeat', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    await gw.create(body())
    const other = await gw.create(body({ name: 'Sanne Bakker' }))
    assert.equal(other.status, 409)
    assert.equal(other.json.error, 'request_id_reused')
    assert.equal(count('createEmployee'), 1)
  })
})

test('the request ids of two projects do not meet', async () => {
  const both = parseProjects({
    projects: [
      { id: 'one', tokenSha256: sha256Hex('token-one-123'), companyId: 2, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } }, actions: { createEmployee: { responsibleUserId: 9 } } },
      { id: 'two', tokenSha256: sha256Hex('token-two-123'), companyId: 3, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } }, actions: { createEmployee: { responsibleUserId: 8 } } },
    ],
  })
  const { odoo, calls } = fakeOdoo()
  const server = createServer(createGateway({ projects: both, odoo, log: () => {}, now: () => NOW }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const post = (token: string) =>
      fetch(`${base}/v1/actions/create_employee`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body()) })
    assert.equal((await post('token-one-123')).status, 200)
    assert.equal((await post('token-two-123')).status, 200)
    const created = calls.filter((call) => call.method === 'createEmployee').map((call) => call.params)
    assert.deepEqual(created, [
      { name: 'Jan de Vries', companyId: 2, responsibleUserId: 9, dateVersion: '2026-10-06', planningRoleIds: [], defaultPlanningRoleId: null },
      { name: 'Jan de Vries', companyId: 3, responsibleUserId: 8, dateVersion: '2026-10-06', planningRoleIds: [], defaultPlanningRoleId: null },
    ])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a second request with the same id while the first is still running is refused, and creates nothing', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { odoo, count } = fakeOdoo({
    async createEmployee(params) {
      await gate
      return params.name ? 41 : 0
    },
  })
  await withGateway(odoo, async (gw) => {
    const first = gw.create(body())
    for (let i = 0; i < 200 && count('checkResponsible') === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await gw.create(body())
    assert.equal(second.status, 409)
    assert.equal(second.json.error, 'in_progress')
    release()
    assert.equal((await first).status, 200)
    assert.equal(count('checkResponsible'), 1)
  })
})

test('two different people with the same name are two employees: there are such people', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.create(body({ requestId: 'req-first-0123456789' }))).status, 200)
    assert.equal((await gw.create(body({ requestId: 'req-second-0123456789' }))).status, 200)
    assert.equal(count('createEmployee'), 2)
  })
})

test('read-back: an employee that came out with an Odoo user or in another company is reported, never as a success', async () => {
  for (const record of [
    { id: 41, name: 'Jan de Vries', companyId: 2, planningRoleIds: null, defaultPlanningRoleId: null, userId: 5, userLinked: true, active: true, resourceId: null, resourceCalendarId: null, tz: null },
    { id: 41, name: 'Jan de Vries', companyId: 2, planningRoleIds: null, defaultPlanningRoleId: null, userId: null, userLinked: true, active: true, resourceId: null, resourceCalendarId: null, tz: null }, // a user is linked, its id was unreadable
    { id: 41, name: 'Jan de Vries', companyId: 3, planningRoleIds: null, defaultPlanningRoleId: null, userId: null, userLinked: false, active: true, resourceId: null, resourceCalendarId: null, tz: null },
    { id: 41, name: 'Jan de Vries', companyId: null, planningRoleIds: null, defaultPlanningRoleId: null, userId: null, userLinked: false, active: true, resourceId: null, resourceCalendarId: null, tz: null }, // company unreadable
  ]) {
    const { odoo, count } = fakeOdoo({ async readEmployee() { return record } })
    await withGateway(odoo, async (gw) => {
      const response = await gw.create(body())
      assert.equal(response.status, 500, JSON.stringify(record))
      assert.equal(response.json.error, 'employee_invariant_violated')
      assert.equal(response.json.details.id, 41, 'the planner is told which employee to look at')
      const again = await gw.create(body())
      assert.equal(again.json.error, 'employee_invariant_violated', 'a repeat gives the same answer')
      assert.equal(count('createEmployee'), 1, 'and creates nothing')
    })
  }
})

test('read-back that cannot be done: created, but not verified', async () => {
  for (const readEmployee of [
    async () => { throw new OdooError('Odoo hr.employee read timed out', 0) },
    async () => null,
  ]) {
    const { odoo, count } = fakeOdoo({ readEmployee })
    await withGateway(odoo, async (gw) => {
      const response = await gw.create(body())
      assert.equal(response.status, 200)
      assert.deepEqual(response.json, { id: 41, name: 'Jan de Vries', verified: false, planningRoles: 0 })
      assert.deepEqual((await gw.create(body())).json, { id: 41, name: 'Jan de Vries', verified: false, planningRoles: 0, replayed: true })
      assert.equal(count('createEmployee'), 1)
    })
  }
})

test('a project can only create a few employees per hour', async () => {
  let now = NOW
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (let i = 0; i < 3; i++) assert.equal((await gw.create(body({ requestId: `req-number-${i}-0123456789` }))).status, 200)
    const blocked = await gw.create(body({ requestId: 'req-number-3-0123456789' }))
    assert.equal(blocked.status, 429)
    assert.equal(blocked.json.error, 'rate_limited')
    assert.equal(count('createEmployee'), 3)
    const replay = await gw.create(body({ requestId: 'req-number-0-0123456789' }))
    assert.equal(replay.status, 200, 'a repeat of a finished request is not a new creation')
    now += 60 * 60_000 + 1
    assert.equal((await gw.create(body({ requestId: 'req-number-3-0123456789' }))).status, 200)
  }, { now: () => now })
})

test('every attempt that reaches Odoo counts for the hourly limit, also a refused one', async () => {
  let attempts = 0
  const { odoo } = fakeOdoo({
    async createEmployee() {
      attempts += 1
      throw new OdooWriteError('x', 403, 'rejected', 'odoo.exceptions.AccessError')
    },
  })
  await withGateway(odoo, async (gw) => {
    for (let i = 0; i < 3; i++) assert.equal((await gw.create(body({ requestId: `req-number-${i}-0123456789` }))).status, 502)
    assert.equal((await gw.create(body({ requestId: 'req-number-9-0123456789' }))).status, 429)
    assert.equal(attempts, 3)
  })
})

test('the log has the request id and the employee id, and never the name, the token or Odoo text', async () => {
  const logs: AccessLogEntry[] = []
  const { odoo } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    await gw.create(body())
    await gw.create(body({ name: '' }))
  }, { logs })
  const text = JSON.stringify(logs)
  assert.equal(logs[0].route, 'POST /v1/actions/create_employee')
  assert.equal(logs[0].status, 200)
  assert.equal(logs[0].requestId, REQUEST)
  assert.equal(logs[0].employeeId, 41)
  assert.ok(!text.includes('Jan de Vries'))
  assert.ok(!text.includes(TOKEN))
  assert.equal(logs[1].status, 400)
})

test('the generic read routes are unchanged: the writer project reads like before and cannot reach hr.employee', async () => {
  const { odoo } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const denied = await gw.create({}, { path: '/v1/models/hr.employee/search_read' })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error, 'model_not_allowed')
    const allowed = await gw.create({}, { path: '/v1/models/planning.slot/search_read' })
    assert.equal(allowed.status, 200)
  })
})

// ---- planning roles: chosen by the planner; a shift with a role can only go to someone who has it ----

const ROLE_BODY = (overrides: Record<string, unknown> = {}) => body({ planningRoleIds: [3, 4], ...overrides })

test('roles chosen in the request: checked in Odoo, set at creation (the first is the default), read back and counted', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const response = await gw.create(ROLE_BODY())
    assert.equal(response.status, 200)
    assert.deepEqual(response.json, { id: 41, name: 'Jan de Vries', verified: true, planningRoles: 2 })
    assert.deepEqual(calls.map((call) => call.method), ['checkResponsible', 'checkPlanningRoles', 'createEmployee', 'readEmployee'])
    assert.deepEqual(calls[1].params, { ids: [3, 4], companyId: 2 })
    assert.deepEqual(calls[2].params, { name: 'Jan de Vries', companyId: 2, responsibleUserId: 9, dateVersion: '2026-10-06', planningRoleIds: [3, 4], defaultPlanningRoleId: 3 })
    assert.deepEqual(calls[3].params, { id: 41, companyId: 2, planningRoles: true })
    assert.deepEqual((await gw.create(ROLE_BODY())).json, { id: 41, name: 'Jan de Vries', verified: true, planningRoles: 2, replayed: true }, 'a repeat gives the same answer')
  })
})

test('no roles in the request: none are checked or set', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (const planningRoleIds of [undefined, []]) {
      calls.length = 0
      const response = await gw.create(body({ requestId: `req-none-${String(planningRoleIds)}-0123456`.slice(0, 40), ...(planningRoleIds && { planningRoleIds }) }))
      assert.equal(response.status, 200)
      assert.equal(response.json.planningRoles, 0)
      assert.ok(!calls.some((call) => call.method === 'checkPlanningRoles'))
      const created = calls.find((call) => call.method === 'createEmployee')?.params as { planningRoleIds: number[]; defaultPlanningRoleId: number | null }
      assert.deepEqual([created.planningRoleIds, created.defaultPlanningRoleId], [[], null])
    }
  })
})

test('the roles of a request must be a short list of different positive integers; nothing reaches Odoo otherwise', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (const planningRoleIds of ['3', 3, null, {}, [0], [-1], [1.5], ['3'], [3, 3], [1, 2, 3, 4, 5, 6], [null]]) {
      const response = await gw.create(ROLE_BODY({ planningRoleIds }))
      assert.equal(response.status, 400, JSON.stringify(planningRoleIds))
      assert.equal(response.json.error, 'invalid_planning_roles')
    }
    assert.equal(calls.length, 0)
  })
})

test('the request can still not choose anything else about the role: other names are refused', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (const extra of [{ planning_role_ids: [1] }, { defaultPlanningRoleId: 1 }, { default_planning_role_id: 1 }, { roleId: 1 }, { roles: [1] }]) {
      const response = await gw.create(ROLE_BODY(extra))
      assert.equal(response.status, 400, JSON.stringify(extra))
      assert.equal(response.json.error, 'unknown_parameter')
    }
    assert.equal(calls.length, 0)
  })
})

test('a role that does not exist or is archived stops the creation, and fixing it makes a retry work', async () => {
  let found: number[] = [3]
  const { odoo, count } = fakeOdoo({ async checkPlanningRoles() { return found } })
  await withGateway(odoo, async (gw) => {
    const refused = await gw.create(ROLE_BODY())
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error, 'planning_role_not_allowed')
    assert.match(refused.json.message, /\b4\b/, 'names the missing role')
    assert.equal(count('createEmployee'), 0)
    found = [3, 4]
    assert.equal((await gw.create(ROLE_BODY())).status, 200, 'the same request id works once the role is back')
    assert.equal(count('createEmployee'), 1)
  })
})

test('a project that limits the roles refuses others before Odoo hears anything, and accepts the allowed ones', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const refused = await gw.create(ROLE_BODY({ planningRoleIds: [3, 5] }), { token: LIMITED })
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error, 'planning_role_not_allowed')
    assert.equal(calls.length, 0, 'not even the responsible was checked')
    assert.equal((await gw.create(ROLE_BODY({ planningRoleIds: [4, 3] }), { token: LIMITED })).status, 200)
    assert.equal((await gw.create(body({ requestId: 'req-second-0123456789' }), { token: LIMITED })).status, 200, 'no roles at all is fine')
  })
})

test('the same request id with other roles, or the same roles in another order, is not a repeat', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.create(ROLE_BODY())).status, 200)
    for (const planningRoleIds of [[3], [4, 3], [3, 4, 5], undefined]) {
      const response = await gw.create(body({ ...(planningRoleIds && { planningRoleIds }) }))
      assert.equal(response.status, 409, JSON.stringify(planningRoleIds))
      assert.equal(response.json.error, 'request_id_reused')
    }
    assert.equal(count('createEmployee'), 1)
  })
})

test('an error while checking the roles creates nothing and is not remembered', async () => {
  let fail = true
  const { odoo, count } = fakeOdoo({
    async checkPlanningRoles(params) {
      if (fail) throw new OdooError("Odoo planning.role read failed (404): the model 'planning.role' does not exist", 404, 'werkzeug.exceptions.NotFound', true)
      return [...params.ids]
    },
  })
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.create(ROLE_BODY())).status, 502)
    assert.equal(count('createEmployee'), 0)
    fail = false
    assert.equal((await gw.create(ROLE_BODY())).status, 200)
  })
})

test('what Odoo says about the roles after creating counts: fewer, none, extra ones, or no answer', async () => {
  type Read = (params: { id: number; companyId: number }) => ReturnType<OdooClient['readEmployee']>
  const record = (planningRoleIds: number[] | null): Read => async (params) => ({ id: params.id, name: 'Jan de Vries', companyId: params.companyId, planningRoleIds, defaultPlanningRoleId: null, userId: null, userLinked: false, active: true, resourceId: null, resourceCalendarId: null, tz: null })
  const cases: Array<[Read, number]> = [
    [record([3]), 1], [record([]), 0], [record([3, 4, 9]), 2], [record(null), 0],
    [async () => { throw new OdooError('Odoo hr.employee read timed out', 0) }, 0],
  ]
  for (const [readEmployee, planningRoles] of cases) {
    const { odoo } = fakeOdoo({ readEmployee })
    await withGateway(odoo, async (gw) => {
      const response = await gw.create(ROLE_BODY())
      assert.equal(response.status, 200)
      assert.equal(response.json.planningRoles, planningRoles)
    })
  }
})

test('the roles do not change the safety checks: an Odoo user on the employee is still reported', async () => {
  const { odoo } = fakeOdoo({
    async readEmployee(params) {
      return { id: params.id, name: 'Jan de Vries', companyId: params.companyId, planningRoleIds: [3, 4], defaultPlanningRoleId: null, userId: 5, userLinked: true, active: true, resourceId: null, resourceCalendarId: null, tz: null }
    },
  })
  await withGateway(odoo, async (gw) => {
    const response = await gw.create(ROLE_BODY())
    assert.equal(response.status, 500)
    assert.equal(response.json.error, 'employee_invariant_violated')
  })
})

test('the list of roles: only for a project with the action, only GET, and limited to the allowed ones', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const all = await gw.create(null, { method: 'GET', path: '/v1/planning-roles' })
    assert.equal(all.status, 200)
    assert.deepEqual(all.json, { roles: [{ id: 3, name: 'Monteur' }, { id: 4, name: 'Planner' }, { id: 5, name: 'Ploegbaas' }] })
    assert.deepEqual(calls[0].params, { companyId: 2 })
    const limited = await gw.create(null, { method: 'GET', path: '/v1/planning-roles', token: LIMITED })
    assert.deepEqual(limited.json.roles.map((role: { id: number }) => role.id), [3, 4])
    calls.length = 0
    assert.equal((await gw.create(null, { method: 'GET', path: '/v1/planning-roles', token: READER })).status, 403, 'a project without the action')
    assert.equal((await gw.create(null, { method: 'GET', path: '/v1/planning-roles', token: null })).status, 401)
    assert.equal((await gw.create({}, { method: 'POST', path: '/v1/planning-roles' })).status, 405)
    assert.equal(calls.length, 0, 'Odoo is not asked in any of these')
  })
})

test('an error while listing the roles is a normal Odoo error', async () => {
  const { odoo } = fakeOdoo({ async listPlanningRoles() { throw new OdooError('Odoo planning.role read timed out', 0) } })
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.create(null, { method: 'GET', path: '/v1/planning-roles' })).status, 504)
  })
})

// ---- planning roles of an existing employee: read them, and set them (the one other write) ----

const SET = '/v1/actions/set_employee_planning_roles'
const setRoles = (gw: Awaited<ReturnType<typeof start>>, body: unknown, token: string | null = ROLEWRITER) => gw.create(body, { path: SET, token })
const getRoles = (gw: Awaited<ReturnType<typeof start>>, id: string | number, token: string | null = ROLEWRITER) => gw.create(null, { method: 'GET', path: `/v1/employees/${id}/planning-roles`, token })
const methods = (calls: Call[]) => calls.map((call) => call.method)

test('read the roles of an employee: what Odoo has now, only with the action, only GET', async () => {
  const { odoo, calls } = fakeOdoo({
    async readEmployee(params) {
      calls.push({ method: 'readEmployee', params })
      return { id: params.id, name: 'Jan', companyId: 2, planningRoleIds: [4, 3], defaultPlanningRoleId: 4, userId: null, userLinked: false, active: true, resourceId: null, resourceCalendarId: null, tz: null }
    },
  })
  await withGateway(odoo, async (gw) => {
    const answer = await getRoles(gw, 41)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, { id: 41, planningRoleIds: [4, 3], defaultPlanningRoleId: 4 })
    assert.deepEqual(calls[0].params, { id: 41, companyId: 2, planningRoles: true })
    calls.length = 0
    assert.equal((await getRoles(gw, 41, TOKEN)).status, 403, 'a project that can only create employees')
    assert.equal((await getRoles(gw, 41, READER)).status, 403)
    assert.equal((await getRoles(gw, 41, null)).status, 401)
    assert.equal((await gw.create({}, { method: 'POST', path: '/v1/employees/41/planning-roles', token: ROLEWRITER })).status, 405)
    assert.equal((await getRoles(gw, 0)).status, 400)
    assert.equal((await getRoles(gw, 'abc')).status, 404, 'not an employee address')
    assert.equal(calls.length, 0, 'Odoo is not asked in any of these')
  })
})

test('read the roles: an employee that does not exist, or is archived, is not found', async () => {
  for (const record of [null, { id: 41, name: 'Jan', companyId: 2, planningRoleIds: [], defaultPlanningRoleId: null, userId: null, userLinked: false, active: false, resourceId: null, resourceCalendarId: null, tz: null }]) {
    const { odoo } = fakeOdoo({ async readEmployee() { return record } })
    await withGateway(odoo, async (gw) => {
      const answer = await getRoles(gw, 41)
      assert.equal(answer.status, 404)
      assert.equal(answer.json.error, 'employee_not_found')
    })
  }
})

test('set the roles: the employee is read, the roles are checked, ONE write is done with the roles and the default, and it is read back', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const answer = await setRoles(gw, { employeeId: 41, planningRoleIds: [4, 3] })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, { id: 41, planningRoles: 2, asked: 2 })
    assert.deepEqual(methods(calls), ['readEmployee', 'checkPlanningRoles', 'setEmployeePlanningRoles', 'readEmployee'])
    assert.deepEqual(calls[1].params, { ids: [4, 3], companyId: 2 })
    assert.deepEqual(calls[2].params, { id: 41, companyId: 2, planningRoleIds: [4, 3], defaultPlanningRoleId: 4 })
    assert.deepEqual(calls[3].params, { id: 41, companyId: 2, planningRoles: true })
  })
})

test('an empty list takes the roles away, without asking Odoo about roles', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const answer = await setRoles(gw, { employeeId: 41, planningRoleIds: [] })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, { id: 41, planningRoles: 0, asked: 0 })
    assert.ok(!methods(calls).includes('checkPlanningRoles'))
    assert.deepEqual(calls.find((call) => call.method === 'setEmployeePlanningRoles')?.params, { id: 41, companyId: 2, planningRoleIds: [], defaultPlanningRoleId: null })
  })
})

test('the request can send the employee and the roles and nothing else; odd values reach neither Odoo nor a write', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (const extra of [{ name: 'Nieuwe naam' }, { user_id: 5 }, { userId: 5 }, { companyId: 3 }, { defaultPlanningRoleId: 3 }, { vals: { active: false } }, { model: 'res.users' }, { requestId: REQUEST }]) {
      const answer = await setRoles(gw, { employeeId: 41, planningRoleIds: [3], ...extra })
      assert.equal(answer.status, 400, JSON.stringify(extra))
      assert.equal(answer.json.error, 'unknown_parameter')
    }
    for (const employeeId of [undefined, 0, -1, 1.5, 'x', null, '41; drop', 2 ** 40, [41], {}]) {
      const answer = await setRoles(gw, { employeeId, planningRoleIds: [3] })
      assert.equal(answer.status, 400, String(employeeId))
      assert.equal(answer.json.error, 'invalid_employee_id')
    }
    for (const planningRoleIds of ['3', 3, null, {}, [0], [-1], [1.5], ['3'], [3, 3], [1, 2, 3, 4, 5, 6], [null]]) {
      const answer = await setRoles(gw, { employeeId: 41, planningRoleIds })
      assert.equal(answer.status, 400, JSON.stringify(planningRoleIds))
      assert.equal(answer.json.error, 'invalid_planning_roles')
    }
    assert.equal((await setRoles(gw, { employeeId: 41 })).json.error, 'invalid_planning_roles', 'the roles are required: an empty list means none')
    assert.equal(calls.length, 0)
  })
})

test('a project that limits the roles refuses others before Odoo hears anything', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const refused = await setRoles(gw, { employeeId: 41, planningRoleIds: [3, 5] })
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error, 'planning_role_not_allowed')
    assert.equal(calls.length, 0)
    assert.equal((await setRoles(gw, { employeeId: 41, planningRoleIds: [5] }, ROLEONLY)).status, 200, 'a project without a limit may set any existing role')
  })
})

test('an employee that is gone, or a role that is gone, stops the change: nothing is written', async () => {
  let found = [3]
  let present = true
  const { odoo, count } = fakeOdoo({
    async readEmployee(params) {
      return present ? { id: params.id, name: 'Jan', companyId: 2, planningRoleIds: [], defaultPlanningRoleId: null, userId: null, userLinked: false, active: true, resourceId: null, resourceCalendarId: null, tz: null } : null
    },
    async checkPlanningRoles() { return found },
  })
  await withGateway(odoo, async (gw) => {
    const roleGone = await setRoles(gw, { employeeId: 41, planningRoleIds: [3, 4] })
    assert.equal(roleGone.status, 409)
    assert.equal(roleGone.json.error, 'planning_role_not_allowed')
    present = false
    const employeeGone = await setRoles(gw, { employeeId: 41, planningRoleIds: [3] })
    assert.equal(employeeGone.status, 404)
    assert.equal(employeeGone.json.error, 'employee_not_found')
    assert.equal(count('setEmployeePlanningRoles'), 0)
    present = true
    found = [3, 4]
    assert.equal((await setRoles(gw, { employeeId: 41, planningRoleIds: [3, 4] })).status, 200, 'once both are back the same request works')
  })
})

test('Odoo refuses the change: an error; an unclear answer: another error; and a repeat is allowed in both cases (it sets the same roles)', async () => {
  let behave: 'refuse' | 'lost' | 'ok' = 'refuse'
  let writes = 0
  const { odoo } = fakeOdoo({
    async setEmployeePlanningRoles() {
      writes += 1
      if (behave === 'refuse') throw new OdooWriteError('Odoo hr.employee write failed (403)', 403, 'rejected', 'odoo.exceptions.AccessError')
      if (behave === 'lost') throw new OdooWriteError('Odoo hr.employee write failed (network)', 0, 'unknown')
    },
  })
  await withGateway(odoo, async (gw) => {
    const refused = await setRoles(gw, { employeeId: 41, planningRoleIds: [3] })
    assert.equal(refused.status, 502)
    assert.equal(refused.json.error, 'odoo_rejected')
    behave = 'lost'
    const lost = await setRoles(gw, { employeeId: 41, planningRoleIds: [3] })
    assert.equal(lost.status, 504)
    assert.equal(lost.json.error, 'outcome_unknown')
    behave = 'ok'
    assert.equal((await setRoles(gw, { employeeId: 41, planningRoleIds: [3] })).status, 200)
    assert.equal(writes, 3, 'nothing was blocked or remembered')
  })
})

test('what Odoo says after the change is counted: fewer, none, extra ones, or no answer; the change itself still counts as done', async () => {
  type Read = (params: { id: number; companyId: number }) => ReturnType<OdooClient['readEmployee']>
  const record = (planningRoleIds: number[] | null): Read => async (params) => ({ id: params.id, name: 'Jan', companyId: params.companyId, planningRoleIds, defaultPlanningRoleId: null, userId: null, userLinked: false, active: true, resourceId: null, resourceCalendarId: null, tz: null })
  const cases: Array<[Read, number]> = [[record([3]), 1], [record([]), 0], [record([3, 4, 9]), 2], [record(null), 0]]
  for (const [readEmployee, planningRoles] of cases) {
    const { odoo } = fakeOdoo({ readEmployee })
    await withGateway(odoo, async (gw) => {
      const answer = await setRoles(gw, { employeeId: 41, planningRoleIds: [3, 4] })
      assert.equal(answer.status, 200)
      assert.equal(answer.json.planningRoles, planningRoles)
    })
  }
  let reads = 0
  const { odoo } = fakeOdoo({
    async readEmployee(params) {
      reads += 1
      if (reads > 1) throw new OdooError('Odoo hr.employee read timed out', 0)
      return { id: params.id, name: 'Jan', companyId: 2, planningRoleIds: [], defaultPlanningRoleId: null, userId: null, userLinked: false, active: true, resourceId: null, resourceCalendarId: null, tz: null }
    },
  })
  await withGateway(odoo, async (gw) => {
    const answer = await setRoles(gw, { employeeId: 41, planningRoleIds: [3] })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, { id: 41, planningRoles: 0, asked: 1 })
  })
})

test('a project can only change a few employees per hour, separate from creating employees', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await setRoles(gw, { employeeId: 41, planningRoleIds: [3] })).status, 200)
    const limited = await setRoles(gw, { employeeId: 41, planningRoleIds: [3] })
    assert.equal(limited.status, 429)
    assert.equal(limited.json.error, 'rate_limited')
    assert.equal(count('setEmployeePlanningRoles'), 3)
    assert.equal((await gw.create(body({ requestId: 'req-create-after-limit-01' }), { token: ROLEWRITER })).status, 200, 'creating is a different limit')
  })
})

test('the roles list works for either action, and shows only what every configured action allows', async () => {
  const { odoo } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const both = await gw.create(null, { method: 'GET', path: '/v1/planning-roles', token: ROLEWRITER })
    assert.deepEqual(both.json.roles.map((role: { id: number }) => role.id), [3, 4], 'allowed by the roles action')
    const only = await gw.create(null, { method: 'GET', path: '/v1/planning-roles', token: ROLEONLY })
    assert.deepEqual(only.json.roles.map((role: { id: number }) => role.id), [3, 4, 5], 'no limit: all')
  })
})

test('the roles action is not an employee-creating action: a project with it cannot create, and one that creates cannot set', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.create(body(), { token: ROLEONLY })).status, 403)
    assert.equal((await setRoles(gw, { employeeId: 41, planningRoleIds: [3] }, TOKEN)).status, 403)
    assert.equal((await setRoles(gw, { employeeId: 41, planningRoleIds: [3] }, READER)).status, 403)
    assert.equal(calls.length, 0)
  })
})

test('the log has the employee id and never the roles, the token or Odoo text', async () => {
  const logs: AccessLogEntry[] = []
  const { odoo } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    await setRoles(gw, { employeeId: 41, planningRoleIds: [4, 3] })
    assert.equal(logs.at(-1)?.route, `POST ${SET}`)
    assert.equal(logs.at(-1)?.employeeId, 41)
    assert.ok(!JSON.stringify(logs).includes(ROLEWRITER))
    assert.ok(!JSON.stringify(logs).includes('planningRoleIds'))
  }, { logs })
})
