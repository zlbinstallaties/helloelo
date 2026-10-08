import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OdooError, OdooWriteError, type EmployeeRecord, type OdooClient, type UnavailabilityRecord } from '../../src/lib/odoo-client.ts'
import { parseProjects, sha256Hex } from '../src/projects.ts'
import { createGateway, type AccessLogEntry } from '../src/server.ts'

const AWAY = 'away-token-123'
const READER = 'reader-token-456'
const OTHER = 'other-token-789'
const REQUEST = 'req-0123456789abcdef'
const MARKER = '[Dashboard] Niet beschikbaar'
const NOW = Date.UTC(2026, 9, 7, 10, 0)

const projects = parseProjects({
  projects: [
    { id: 'dashboard-away', tokenSha256: sha256Hex(AWAY), companyId: 2, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } }, actions: { employeeUnavailability: { maxPerHour: 3 } } },
    { id: 'preview', tokenSha256: sha256Hex(READER), companyId: 2, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } } },
    { id: 'roles-only', tokenSha256: sha256Hex(OTHER), companyId: 2, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } }, actions: { setEmployeePlanningRoles: {} } },
  ],
})

type Call = { method: string; params: any }

const employee = (overrides: Partial<EmployeeRecord> = {}): EmployeeRecord => ({
  id: 41, name: 'Jan', companyId: 2, planningRoleIds: null, defaultPlanningRoleId: null, userId: null, userLinked: false, active: true,
  resourceId: 77, resourceCalendarId: 5, tz: 'Europe/Amsterdam', ...overrides,
})

function fakeOdoo(overrides: Partial<OdooClient> = {}, employees: Record<number, EmployeeRecord | null> = {}) {
  const calls: Call[] = []
  const leaves = new Map<number, UnavailabilityRecord>()
  let next = 901
  const known: Record<number, EmployeeRecord | null> = {
    41: employee(), 42: employee({ id: 42, active: false }), 43: employee({ id: 43, companyId: 3 }), 44: employee({ id: 44, resourceId: null }),
    45: employee({ id: 45, tz: null }), 46: employee({ id: 46, tz: 'Mars/Olympus' }), 47: employee({ id: 47, resourceId: 78 }), ...employees,
  }
  const unexpected = (name: string) => async () => { throw new Error(`unexpected call: ${name}`) }
  const odoo: OdooClient = {
    searchRead: unexpected('searchRead'), searchCount: unexpected('searchCount'), fieldsGet: unexpected('fieldsGet'), createEmployee: unexpected('createEmployee'),
    setEmployeePlanningRoles: unexpected('setEmployeePlanningRoles'), checkResponsible: unexpected('checkResponsible'), checkPlanningRoles: unexpected('checkPlanningRoles'),
    listPlanningRoles: unexpected('listPlanningRoles'), readReferencePartner: unexpected('readReferencePartner'), postDocument: unexpected('postDocument'),
    async readEmployee(params) {
      calls.push({ method: 'readEmployee', params })
      return known[params.id] ?? null
    },
    async createUnavailability(params) {
      calls.push({ method: 'createUnavailability', params })
      const id = next++
      leaves.set(id, { id, name: params.name, resourceId: params.resourceId, dateFrom: params.dateFrom, dateTo: params.dateTo })
      return id
    },
    async readUnavailability(params) {
      calls.push({ method: 'readUnavailability', params })
      return leaves.get(params.id) ?? null
    },
    async removeUnavailability(params) {
      calls.push({ method: 'removeUnavailability', params })
      leaves.delete(params.id)
    },
    ...overrides,
  }
  const names = () => calls.map((call) => call.method)
  const count = (method: string) => calls.filter((call) => call.method === method).length
  return { odoo, calls, leaves, names, count }
}

async function withGateway(odoo: OdooClient, run: (gw: ReturnType<typeof client>) => Promise<void>, options: { logs?: AccessLogEntry[]; now?: () => number } = {}) {
  const server: Server = createServer(createGateway({ projects, odoo, log: (entry) => options.logs?.push(entry), now: options.now ?? (() => NOW) }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function client(base: string) {
  async function send(path: string, body: unknown, init: { token?: string | null; method?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (init.token !== null) headers.authorization = `Bearer ${init.token ?? AWAY}`
    const method = init.method ?? 'POST'
    const response = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body) })
    return { status: response.status, json: (await response.json()) as Record<string, any> }
  }
  return {
    add: (body: unknown, init?: { token?: string | null; method?: string }) => send('/v1/actions/add_employee_unavailability', body, init),
    remove: (body: unknown, init?: { token?: string | null; method?: string }) => send('/v1/actions/remove_employee_unavailability', body, init),
  }
}

const add = (overrides: Record<string, unknown> = {}) => ({ requestId: REQUEST, employeeId: 41, from: '2026-10-12', to: '2026-10-13', note: 'Vakantie', ...overrides })

test('a project without the action cannot add or remove, and Odoo is not called; no token or a wrong token is 401', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (const token of [READER, OTHER]) {
      assert.equal((await gw.add(add(), { token })).json.error, 'action_not_allowed')
      assert.equal((await gw.remove({ employeeId: 41, leaveId: 901 }, { token })).json.error, 'action_not_allowed')
    }
    assert.equal((await gw.add(add(), { token: null })).status, 401)
    assert.equal((await gw.add(add(), { token: 'nope' })).status, 401)
    assert.equal((await gw.remove({ employeeId: 41, leaveId: 901 }, { token: null })).status, 401)
    assert.equal((await gw.add(add(), { method: 'GET' })).status, 405)
    assert.equal((await gw.remove({}, { method: 'GET' })).status, 405)
    assert.equal(calls.length, 0)
  })
})

test('adding: one create of one record for the resource of that employee, in his time zone, with the note in the name, and a read-back', async () => {
  const { odoo, calls, names } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const answer = await gw.add(add())
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, { id: 901, employeeId: 41, from: '2026-10-12', to: '2026-10-13', verified: true })
    assert.deepEqual(names(), ['readEmployee', 'createUnavailability', 'readUnavailability'])
    assert.deepEqual(calls[0].params, { id: 41, companyId: 2, resource: true })
    assert.deepEqual(calls[1].params, {
      name: `${MARKER}: Vakantie`, resourceId: 77, calendarId: 5, companyId: 2, dateFrom: '2026-10-11 22:00:00', dateTo: '2026-10-13 21:59:59',
    })
    assert.deepEqual(calls[2].params, { id: 901, companyId: 2 })
  })
})

test('adding without a note, and a note that is plain text of at most 200 characters', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.add(add({ note: undefined }))).status, 200)
    assert.equal(calls.find((call) => call.method === 'createUnavailability')?.params.name, MARKER)
    assert.equal((await gw.add(add({ requestId: 'req-2-0123456789abcd', note: 'x'.repeat(200), from: '2026-11-01', to: '2026-11-01' }))).status, 200)
    assert.equal((await gw.add(add({ requestId: 'req-3-0123456789abcd', note: '   ', from: '2026-11-03', to: '2026-11-03' }))).status, 200)
    assert.equal(calls.filter((call) => call.method === 'createUnavailability').at(-1)?.params.name, MARKER, 'spaces only is no note')
  })
})

test('adding: only requestId, employeeId, from, to and note; anything else is refused before Odoo hears anything', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (const extra of [{ name: 'Andere' }, { resourceId: 5 }, { resource_id: 5 }, { calendarId: 3 }, { dateFrom: '2026-10-12 00:00:00' }, { vals: { active: false } }, { companyId: 3 }, { model: 'hr.employee' }, { ids: [1] }, { user_id: 5 }]) {
      const answer = await gw.add(add(extra))
      assert.equal(answer.status, 400, JSON.stringify(extra))
      assert.equal(answer.json.error, 'unknown_parameter')
    }
    assert.equal(calls.length, 0)
  })
})

test('adding: odd ids, dates and notes are a 400 and Odoo is not called', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ requestId: 'kort' }, 'invalid_request_id'], [{ requestId: 5 }, 'invalid_request_id'], [{ requestId: undefined }, 'invalid_request_id'],
      [{ employeeId: 0 }, 'invalid_employee_id'], [{ employeeId: -1 }, 'invalid_employee_id'], [{ employeeId: 1.5 }, 'invalid_employee_id'], [{ employeeId: undefined }, 'invalid_employee_id'],
      [{ from: '2026-02-30' }, 'invalid_dates'], [{ from: '12-10-2026' }, 'invalid_dates'], [{ to: '' }, 'invalid_dates'], [{ to: 5 }, 'invalid_dates'], [{ from: undefined }, 'invalid_dates'],
      [{ from: '2026-10-14', to: '2026-10-13' }, 'invalid_dates'], [{ from: '2026-10-12', to: '2027-10-13' }, 'invalid_dates'],
      [{ note: 'x'.repeat(201) }, 'invalid_note'], [{ note: 'twee\nregels' }, 'invalid_note'], [{ note: 5 }, 'invalid_note'], [{ note: {} }, 'invalid_note'],
    ]
    for (const [overrides, code] of cases) {
      const answer = await gw.add(add(overrides))
      assert.equal(answer.status, 400, JSON.stringify(overrides))
      assert.equal(answer.json.error, code, JSON.stringify(overrides))
    }
    assert.equal((await gw.add(add({ from: '2026-10-12', to: '2027-10-12' }))).status, 200, '366 days is the longest')
    assert.equal(calls.filter((call) => call.method === 'createUnavailability').length, 1)
  })
})

test('adding: the employee must exist in the company, be active, and have a resource and a known time zone; otherwise nothing is written', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const expect = async (employeeId: number, status: number, code: string) => {
      const answer = await gw.add(add({ employeeId, requestId: `req-${employeeId}-0123456789abcdef` }))
      assert.equal(answer.status, status, String(employeeId))
      assert.equal(answer.json.error, code, String(employeeId))
    }
    await expect(99, 404, 'employee_not_found')
    await expect(42, 404, 'employee_not_found')
    await expect(43, 404, 'employee_not_found')
    await expect(44, 409, 'employee_has_no_resource')
    await expect(45, 409, 'employee_timezone_unknown')
    await expect(46, 409, 'employee_timezone_unknown')
    assert.equal(count('createUnavailability'), 0)
  })
})

test('adding twice with the same request id gives the same record, once; another body with that id is refused', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const first = await gw.add(add())
    const again = await gw.add(add())
    assert.deepEqual(again.json, { ...first.json, replayed: true })
    assert.equal(count('createUnavailability'), 1)
    for (const other of [{ employeeId: 47 }, { from: '2026-10-11' }, { to: '2026-10-14' }, { note: 'Anders' }, { note: undefined }]) {
      const refused = await gw.add(add(other))
      assert.equal(refused.status, 409, JSON.stringify(other))
      assert.equal(refused.json.error, 'request_id_reused')
    }
    assert.equal(count('createUnavailability'), 1)
  })
})

test('adding: while the first request runs, a repeat is refused', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { odoo, count } = fakeOdoo({
    async createUnavailability() { await gate; return 901 },
  })
  await withGateway(odoo, async (gw) => {
    const running = gw.add(add())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const repeat = await gw.add(add())
    assert.equal(repeat.status, 409)
    assert.equal(repeat.json.error, 'in_progress')
    release()
    assert.equal((await running).status, 200)
    assert.equal(count('readEmployee'), 1, 'the repeat did not ask Odoo anything')
  })
})

test('adding: Odoo refuses: an error, and the same request may be tried again; no usable answer: it is blocked, nothing is created twice', async () => {
  let mode: 'reject' | 'unknown' | 'fine' = 'reject'
  const { odoo, count } = fakeOdoo({
    async createUnavailability() {
      if (mode === 'reject') throw new OdooWriteError('no', 403, 'rejected', 'odoo.exceptions.AccessError')
      if (mode === 'unknown') throw new OdooWriteError('down', 0, 'unknown')
      return 901
    },
  })
  await withGateway(odoo, async (gw) => {
    const refused = await gw.add(add())
    assert.equal(refused.status, 502)
    assert.equal(refused.json.error, 'odoo_rejected')
    mode = 'fine'
    assert.equal((await gw.add(add())).status, 200, 'after a refusal the same request may be repeated')

    mode = 'unknown'
    const unclear = await gw.add(add({ requestId: 'req-2-0123456789abcdef' }))
    assert.equal(unclear.status, 504)
    assert.equal(unclear.json.error, 'outcome_unknown')
    mode = 'fine'
    const blocked = await gw.add(add({ requestId: 'req-2-0123456789abcdef' }))
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json.error, 'outcome_unknown')
    assert.equal(count('readEmployee'), 3, 'the blocked repeat did not ask Odoo anything')
  })
})

test('adding: the read-back says whether Odoo has what was asked; a failing read-back is not a failed add', async () => {
  const wrong = fakeOdoo({
    async readUnavailability() { return { id: 901, name: `${MARKER}: Vakantie`, resourceId: 99, dateFrom: '2026-10-11 22:00:00', dateTo: '2026-10-13 21:59:59' } },
  })
  await withGateway(wrong.odoo, async (gw) => assert.equal((await gw.add(add())).json.verified, false, 'another resource'))
  const missing = fakeOdoo({ async readUnavailability() { return null } })
  await withGateway(missing.odoo, async (gw) => assert.equal((await gw.add(add())).json.verified, false, 'not found'))
  const shifted = fakeOdoo({
    async readUnavailability() { return { id: 901, name: `${MARKER}: Vakantie`, resourceId: 77, dateFrom: '2026-10-12 00:00:00', dateTo: '2026-10-13 23:59:59' } },
  })
  await withGateway(shifted.odoo, async (gw) => assert.equal((await gw.add(add())).json.verified, false, 'other dates'))
  const shorter = fakeOdoo({
    async readUnavailability() { return { id: 901, name: `${MARKER}: Vakantie`, resourceId: 77, dateFrom: '2026-10-11 22:00:00', dateTo: '2026-10-12 21:59:59' } },
  })
  await withGateway(shorter.odoo, async (gw) => assert.equal((await gw.add(add())).json.verified, false, 'another end'))
  const renamed = fakeOdoo({
    async readUnavailability() { return { id: 901, name: 'Iets anders', resourceId: 77, dateFrom: '2026-10-11 22:00:00', dateTo: '2026-10-13 21:59:59' } },
  })
  await withGateway(renamed.odoo, async (gw) => assert.equal((await gw.add(add())).json.verified, false, 'another name'))
  const broken = fakeOdoo({ async readUnavailability() { throw new OdooError('down', 0) } })
  await withGateway(broken.odoo, async (gw) => {
    const answer = await gw.add(add())
    assert.equal(answer.status, 200)
    assert.equal(answer.json.id, 901)
    assert.equal(answer.json.verified, false)
  })
})

test('at most a few changes per hour per project, adding and removing together; an hour later it works again', async () => {
  let now = NOW
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    for (let index = 1; index <= 2; index++) assert.equal((await gw.add(add({ requestId: `req-${index}-0123456789abcdef`, from: `2026-11-0${index}`, to: `2026-11-0${index}` }))).status, 200)
    assert.equal((await gw.remove({ employeeId: 41, leaveId: 901 })).status, 200)
    const limited = await gw.add(add({ requestId: 'req-9-0123456789abcdef' }))
    assert.equal(limited.status, 429)
    assert.equal(limited.json.error, 'rate_limited')
    assert.equal((await gw.remove({ employeeId: 41, leaveId: 902 })).status, 429)
    assert.equal(count('createUnavailability'), 2, 'the refused one never reached Odoo')
    now += 61 * 60_000
    assert.equal((await gw.add(add({ requestId: 'req-9-0123456789abcdef' }))).status, 200)
  }, { now: () => now })
})

const present = (leaves: Map<number, UnavailabilityRecord>, record: Partial<UnavailabilityRecord> = {}) =>
  leaves.set(901, { id: 901, name: `${MARKER}: Vakantie`, resourceId: 77, dateFrom: '2026-10-11 22:00:00', dateTo: '2026-10-13 21:59:59', ...record })

test('removing: one unlink, of a record that the dashboard made for this employee, after reading it', async () => {
  const { odoo, leaves, calls, names } = fakeOdoo()
  present(leaves)
  await withGateway(odoo, async (gw) => {
    const answer = await gw.remove({ employeeId: 41, leaveId: 901 })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, { leaveId: 901, removed: true })
    assert.deepEqual(names(), ['readEmployee', 'readUnavailability', 'removeUnavailability'])
    assert.deepEqual(calls[2].params, { id: 901, companyId: 2 })
    assert.equal(leaves.size, 0)
  })
})

test('removing a record that is already gone is fine, and asks Odoo to remove nothing', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    const answer = await gw.remove({ employeeId: 41, leaveId: 901 })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, { leaveId: 901, removed: false, alreadyGone: true })
    assert.equal(count('removeUnavailability'), 0)
  })
})

test('removing never touches what the dashboard did not make for this employee: another resource, a record of nobody, or one made by hand', async () => {
  for (const record of [{ resourceId: 78 }, { resourceId: null }, { name: 'Vakantie van Jan' }, { name: `Een ${MARKER}` }, { name: '' }, { name: `${MARKER}x` }]) {
    const { odoo, leaves, count } = fakeOdoo()
    present(leaves, record)
    await withGateway(odoo, async (gw) => {
      const answer = await gw.remove({ employeeId: 41, leaveId: 901 })
      assert.equal(answer.status, 404, JSON.stringify(record))
      assert.equal(answer.json.error, 'unavailability_not_found')
      assert.equal(count('removeUnavailability'), 0, JSON.stringify(record))
      assert.equal(leaves.size, 1)
    })
  }
})

test('removing: the employee must exist in the company and have a resource; odd values and other parameters are refused', async () => {
  const { odoo, leaves, calls } = fakeOdoo()
  present(leaves)
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.remove({ employeeId: 99, leaveId: 901 })).json.error, 'employee_not_found')
    assert.equal((await gw.remove({ employeeId: 43, leaveId: 901 })).json.error, 'employee_not_found')
    assert.equal((await gw.remove({ employeeId: 44, leaveId: 901 })).json.error, 'employee_has_no_resource')
    assert.equal((await gw.remove({ employeeId: 42, leaveId: 901 })).status, 200, 'an employee who has left can still have his record removed')
    for (const bad of [{ leaveId: 0 }, { leaveId: -1 }, { leaveId: '901' }, { leaveId: 1.5 }, { leaveId: undefined }, { employeeId: 0 }, { employeeId: undefined }]) {
      const answer = await gw.remove({ employeeId: 41, leaveId: 901, ...bad })
      assert.equal(answer.status, 400, JSON.stringify(bad))
    }
    for (const extra of [{ ids: [1, 2] }, { model: 'hr.employee' }, { vals: {} }, { requestId: REQUEST }]) {
      const answer = await gw.remove({ employeeId: 41, leaveId: 901, ...extra })
      assert.equal(answer.status, 400, JSON.stringify(extra))
      assert.equal(answer.json.error, 'unknown_parameter')
    }
    assert.equal(calls.filter((call) => call.method === 'removeUnavailability').length, 1, 'only the one valid removal reached Odoo')
  })
})

test('removing: Odoo refuses: an error; no usable answer: another error; and a repeat is allowed in both cases', async () => {
  let mode: 'reject' | 'unknown' = 'reject'
  const { odoo, leaves } = fakeOdoo({
    async removeUnavailability() {
      throw mode === 'reject' ? new OdooWriteError('no', 403, 'rejected', 'odoo.exceptions.AccessError') : new OdooWriteError('down', 0, 'unknown')
    },
  })
  present(leaves)
  await withGateway(odoo, async (gw) => {
    const refused = await gw.remove({ employeeId: 41, leaveId: 901 })
    assert.equal(refused.status, 502)
    assert.equal(refused.json.error, 'odoo_rejected')
    mode = 'unknown'
    const unclear = await gw.remove({ employeeId: 41, leaveId: 901 })
    assert.equal(unclear.status, 504)
    assert.equal(unclear.json.error, 'outcome_unknown')
    assert.equal(leaves.size, 1)
  })
})

test('the log has the employee and the request, and never the note, a date, the token or Odoo text', async () => {
  const logs: AccessLogEntry[] = []
  const { odoo, leaves } = fakeOdoo()
  await withGateway(odoo, async (gw) => {
    await gw.add(add({ note: 'geheime opmerking' }))
    present(leaves)
    await gw.remove({ employeeId: 41, leaveId: 901 })
    await gw.add(add({ employeeId: 99, requestId: 'req-9-0123456789abcdef' }))
  }, { logs })
  const text = JSON.stringify(logs)
  for (const secret of ['geheime opmerking', '2026-10-12', AWAY, 'Vakantie']) assert.ok(!text.includes(secret), secret)
  assert.deepEqual(logs.map((entry) => [entry.route, entry.status, entry.employeeId, entry.requestId]), [
    ['POST /v1/actions/add_employee_unavailability', 200, 41, REQUEST],
    ['POST /v1/actions/remove_employee_unavailability', 200, 41, undefined],
    ['POST /v1/actions/add_employee_unavailability', 404, 99, 'req-9-0123456789abcdef'],
  ])
})

test('the action is no other action: a project with it cannot create employees or set roles, and one without it cannot add', async () => {
  const { odoo } = fakeOdoo()
  const server = createServer(createGateway({ projects, odoo, now: () => NOW }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    for (const path of ['/v1/actions/create_employee', '/v1/actions/set_employee_planning_roles']) {
      const response = await fetch(url + path, { method: 'POST', headers: { authorization: `Bearer ${AWAY}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: REQUEST, name: 'X', employeeId: 41, planningRoleIds: [] }) })
      assert.equal(response.status, 403, path)
    }
    const roles = await fetch(`${url}/v1/employees/41/planning-roles`, { headers: { authorization: `Bearer ${AWAY}` } })
    assert.equal(roles.status, 403)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('when Odoo answers with an error, the log says which kind (its class name), so a wrong key or missing right can be seen; never free text', async () => {
  const logs: AccessLogEntry[] = []
  let thrown: OdooError = new OdooError('Odoo hr.employee read failed (401): Jan de Vries is geheim', 401, 'odoo.exceptions.AccessDenied', true)
  const { odoo } = fakeOdoo({ async readEmployee() { throw thrown } })
  await withGateway(odoo, async (gw) => {
    assert.equal((await gw.add(add())).status, 502)
    thrown = new OdooError('Odoo hr.employee read failed (network)', 0)
    assert.equal((await gw.add(add({ requestId: 'req-2-0123456789abcdef' }))).status, 502)
    thrown = new OdooError('failed', 500, 'Jan de Vries, Straat 1', true)
    assert.equal((await gw.add(add({ requestId: 'req-3-0123456789abcdef' }))).status, 502)
    assert.equal((await gw.add(add({ requestId: 'req-4-0123456789abcdef', employeeId: 0 }))).status, 400)
  }, { logs })
  assert.deepEqual(logs.map((entry) => [entry.status, entry.code, entry.upstream]), [
    [502, 'odoo_error', 'odoo.exceptions.AccessDenied'],
    [502, 'odoo_error', 'upstream status 0'],
    [502, 'odoo_error', undefined],
    [400, 'invalid_employee_id', undefined],
  ])
  assert.ok(!JSON.stringify(logs).includes('Jan de Vries'))
})
