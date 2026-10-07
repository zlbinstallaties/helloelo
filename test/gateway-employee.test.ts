import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmployeeViaGateway, listPlanningRolesViaGateway, readEmployeeRolesViaGateway, setEmployeeRolesViaGateway } from '../src/lib/gateway-employee.ts'
import type { GatewayOutcome } from '../src/lib/gateway-employee.ts'

const TOKEN = 'gateway-token-very-secret'
const REQUEST = 'req-0123456789abcdef'

function run(reply: () => Response | Promise<Response>, extra: { timeoutMs?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return reply()
  }) as unknown as typeof fetch
  const outcome = createEmployeeViaGateway({ url: 'http://odoo-gateway:8070', token: TOKEN, requestId: REQUEST, name: 'Jan de Vries', fetchImpl, ...extra })
  return { calls, outcome }
}

const answer = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

test('the request has the request id and the name, and nothing else: no company, no responsible, no user', async () => {
  const { calls, outcome } = run(() => answer(200, { id: 41, name: 'Jan de Vries', verified: true }))
  await outcome
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://odoo-gateway:8070/v1/actions/create_employee')
  assert.equal(calls[0].init.method, 'POST')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.authorization, `Bearer ${TOKEN}`)
  assert.match(headers['content-type'], /^application\/json/)
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { requestId: REQUEST, name: 'Jan de Vries' })
})

test('Odoo confirmed: the number of planning roles is taken over only when it is a plausible count', async () => {
  const roles = async (value: unknown) => (await run(() => answer(200, { id: 41, name: 'Jan', verified: true, planningRoles: value })).outcome) as { planningRoles: number }
  assert.equal((await roles(2)).planningRoles, 2)
  assert.equal((await roles(0)).planningRoles, 0)
  for (const value of [-1, 1.5, '2', 100, null, undefined, [], {}]) assert.equal((await roles(value)).planningRoles, 0, JSON.stringify(value))
})

test('the gateway refuses because a planning role is gone: nothing was created, so trying again is safe', async () => {
  const outcome = await run(() => answer(409, { error: 'planning_role_not_allowed', message: 'the configured planning role 4 does not exist or is archived' })).outcome
  assert.equal(outcome.kind, 'rejected')
  assert.match(outcome.message, /planningsrol/)
  assert.match(outcome.message, /niets aangemaakt/)
})

test('Odoo confirmed: the id, whether it was verified, and whether this was a repeat', async () => {
  assert.deepEqual(await run(() => answer(200, { id: 41, name: 'Jan', verified: true })).outcome, { kind: 'created', id: 41, verified: true, planningRoles: 0, replayed: false })
  assert.deepEqual(await run(() => answer(200, { id: 41, name: 'Jan', verified: false })).outcome, { kind: 'created', id: 41, verified: false, planningRoles: 0, replayed: false })
  assert.deepEqual(await run(() => answer(200, { id: 41, name: 'Jan', verified: true, replayed: true })).outcome, { kind: 'created', id: 41, verified: true, planningRoles: 0, replayed: true })
})

test('a success that does not name an employee is not a success', async () => {
  for (const body of [{}, { id: 0 }, { id: -3 }, { id: 1.5 }, { id: '41' }, { id: null }, 'ok', '', []]) {
    const outcome = await run(() => answer(200, body)).outcome
    assert.equal(outcome.kind, 'unknown', JSON.stringify(body))
  }
})

test('refused at the door: the action is off for this token, or the token is wrong: nothing was created', async () => {
  for (const [status, body] of [[403, { error: 'action_not_allowed' }], [401, { error: 'unauthorized' }], [403, 'nope']] as const) {
    const outcome = await run(() => answer(status, body)).outcome
    assert.equal(outcome.kind, 'not_enabled', String(status))
  }
  const off = await run(() => answer(403, { error: 'action_not_allowed' })).outcome
  assert.match((off as { message: string }).message, /staat niet aan/)
})

test('Odoo or the gateway refused before creating anything: a definite no, trying again is safe', async () => {
  const refusals: Array<[number, Record<string, unknown>, RegExp]> = [
    [409, { error: 'responsible_not_allowed' }, /verantwoordelijke/],
    [429, { error: 'rate_limited' }, /per uur/],
    [502, { error: 'odoo_rejected', message: 'odoo.exceptions.AccessError' }, /geweigerd/],
    [502, { error: 'odoo_error', message: 'upstream status 500' }, /niets aangemaakt/],
    [504, { error: 'odoo_timeout' }, /niets aangemaakt/],
    [400, { error: 'invalid_name' }, /geweigerd/],
  ]
  for (const [status, body, text] of refusals) {
    const outcome = await run(() => answer(status, body)).outcome
    assert.equal(outcome.kind, 'rejected', `${status} ${JSON.stringify(body)}`)
    assert.match((outcome as { message: string }).message, text)
  }
})

test('no usable answer is an unknown outcome: the employee may exist, so no new try', async () => {
  const unknown: Array<() => Response | Promise<Response>> = [
    () => answer(504, { error: 'outcome_unknown' }),
    () => answer(409, { error: 'outcome_unknown' }),
    () => answer(409, { error: 'in_progress' }),
    () => answer(409, { error: 'request_id_reused' }),
    () => answer(502, '<html>Bad gateway</html>'),
    () => answer(503, ''),
    () => answer(500, { error: 'internal_error' }),
    () => answer(418, { error: 'theepot' }),
    () => { throw new TypeError('fetch failed') },
    () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })),
  ]
  for (const reply of unknown) {
    const outcome = await run(reply).outcome
    assert.equal(outcome.kind, 'unknown')
    assert.ok(!(outcome as { message: string }).message.includes(TOKEN))
  }
})

test('a time-out of the call to the gateway is an unknown outcome too', async () => {
  const { outcome } = run(() => new Promise<Response>(() => {}), { timeoutMs: 20 })
  assert.equal((await outcome).kind, 'unknown')
})

test('an employee that Odoo made but not as intended is reported with its id, never as a success', async () => {
  const outcome = (await run(() => answer(500, { error: 'employee_invariant_violated', details: { id: 41 } })).outcome) as Extract<GatewayOutcome, { kind: 'invariant' }>
  assert.equal(outcome.kind, 'invariant')
  assert.equal(outcome.id, 41)
  assert.match(outcome.message, /41/)
  const noId = await run(() => answer(500, { error: 'employee_invariant_violated' })).outcome
  assert.equal(noId.kind, 'unknown')
})

test('the Odoo message is passed on only when it is a plain class name, not free text', async () => {
  const plain = (await run(() => answer(502, { error: 'odoo_rejected', message: 'odoo.exceptions.AccessError' })).outcome) as { message: string }
  assert.match(plain.message, /odoo\.exceptions\.AccessError/)
  const free = (await run(() => answer(502, { error: 'odoo_rejected', message: 'Jan de Vries <jan@example.com> mag dit niet' })).outcome) as { message: string }
  assert.ok(!free.message.includes('jan@example.com'))
})

test('the chosen planning roles go along, only when there are any, and nothing else about them', async () => {
  const send = async (planningRoleIds?: readonly number[]) => {
    const calls: Array<{ body: Record<string, unknown> }> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) })
      return answer(200, { id: 41, name: 'Jan', verified: true, planningRoles: 2 })
    }) as unknown as typeof fetch
    await createEmployeeViaGateway({ url: 'http://odoo-gateway:8070', token: TOKEN, requestId: REQUEST, name: 'Jan de Vries', planningRoleIds, fetchImpl })
    return calls[0].body
  }
  assert.deepEqual(await send([4, 3]), { requestId: REQUEST, name: 'Jan de Vries', planningRoleIds: [4, 3] }, 'order kept: the first is the default')
  assert.deepEqual(await send([]), { requestId: REQUEST, name: 'Jan de Vries' })
  assert.deepEqual(await send(undefined), { requestId: REQUEST, name: 'Jan de Vries' })
})

function listRun(reply: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return reply()
  }) as unknown as typeof fetch
  return { calls, result: listPlanningRolesViaGateway({ url: 'http://odoo-gateway:8070', token: TOKEN, fetchImpl }) }
}

test('the list of planning roles is a plain GET with the token, and only well-formed roles are taken over', async () => {
  const { calls, result } = listRun(() => answer(200, { roles: [{ id: 3, name: 'Monteur' }, { id: 0, name: 'Nul' }, { id: 4, name: '  ' }, { id: '5', name: 'Tekst' }, { id: 6 }, null, { id: 7, name: 'Planner', extra: 'x' }] }))
  assert.deepEqual(await result, { ok: true, roles: [{ id: 3, name: 'Monteur' }, { id: 7, name: 'Planner' }] })
  assert.equal(calls[0].url, 'http://odoo-gateway:8070/v1/planning-roles')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`)
  assert.equal(calls[0].init.body, undefined)
})

test('the list of planning roles: clear messages for a wrong token, an action that is off, an Odoo problem or no connection', async () => {
  const failure = async (reply: () => Response | Promise<Response>) => {
    const result = await listRun(reply).result
    assert.equal(result.ok, false)
    return result.ok ? '' : result.message
  }
  assert.match(await failure(() => answer(401, { error: 'unauthorized' })), /token/)
  assert.match(await failure(() => answer(403, { error: 'action_not_allowed' })), /niet aan/)
  for (const reply of [() => answer(502, { error: 'odoo_error' }), () => answer(200, { roles: 'x' }), () => answer(200, 'geen json'), () => answer(200, {})]) {
    assert.match(await failure(reply), /planningsrollen konden niet/)
  }
  assert.match(await failure(() => { throw new TypeError('connection reset') }), /planningsrollen konden niet/)
  assert.ok(!(await failure(() => answer(401, { error: 'x' }))).includes(TOKEN), 'the token is never in a message')
})

// ---- the planning roles of one existing employee ----

function viaGateway<T>(call: (fetchImpl: typeof fetch) => Promise<T>, reply: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return reply()
  }) as unknown as typeof fetch
  return { calls, result: call(fetchImpl) }
}
const readRoles = (reply: () => Response | Promise<Response>, employeeId = 41) =>
  viaGateway((fetchImpl) => readEmployeeRolesViaGateway({ url: 'http://odoo-gateway:8070', token: TOKEN, employeeId, fetchImpl }), reply)
const setRoles = (reply: () => Response | Promise<Response>, planningRoleIds: readonly number[] = [4, 3], employeeId = 41) =>
  viaGateway((fetchImpl) => setEmployeeRolesViaGateway({ url: 'http://odoo-gateway:8070', token: TOKEN, employeeId, planningRoleIds, fetchImpl }), reply)

test('reading the roles of an employee: a plain GET with the token, the roles and the default as ids', async () => {
  const { calls, result } = readRoles(() => answer(200, { id: 41, planningRoleIds: [4, 3], defaultPlanningRoleId: 4 }))
  assert.deepEqual(await result, { ok: true, planningRoleIds: [4, 3], defaultPlanningRoleId: 4 })
  assert.equal(calls[0].url, 'http://odoo-gateway:8070/v1/employees/41/planning-roles')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(await readRoles(() => answer(200, { id: 41, planningRoleIds: [], defaultPlanningRoleId: null })).result, { ok: true, planningRoleIds: [], defaultPlanningRoleId: null })
  assert.deepEqual(await readRoles(() => answer(200, { id: 41, planningRoleIds: [3], defaultPlanningRoleId: 'x' })).result, { ok: true, planningRoleIds: [3], defaultPlanningRoleId: null })
})

test('reading the roles: not found, a token that is wrong, an action that is off, and anything odd are told apart and kept short', async () => {
  const fail = async (reply: () => Response | Promise<Response>) => (await readRoles(reply).result) as { ok: false; message: string; notFound?: boolean }
  const notFound = await fail(() => answer(404, { error: 'employee_not_found', message: 'no active employee with this id' }))
  assert.equal(notFound.notFound, true)
  assert.match(notFound.message, /bestaat niet/)
  assert.match((await fail(() => answer(401, { error: 'unauthorized' }))).message, /token/)
  assert.match((await fail(() => answer(403, { error: 'action_not_allowed' }))).message, /niet aan/)
  for (const reply of [() => answer(502, { error: 'odoo_error' }), () => answer(500, { planningRoleIds: [3], defaultPlanningRoleId: 3 }), () => answer(200, { planningRoleIds: 'x' }), () => answer(200, { planningRoleIds: [0] }), () => answer(200, { planningRoleIds: ['3'] }), () => answer(200, 'geen json'), () => { throw new TypeError('connection reset') }]) {
    const result = await fail(reply)
    assert.equal(result.ok, false)
    assert.equal(result.notFound, undefined)
    assert.match(result.message, /konden niet/)
  }
})

test('the roles of an employee id that is not an id are not even asked for', async () => {
  for (const employeeId of [0, -1, 1.5, Number.NaN]) {
    const { calls, result } = readRoles(() => answer(200, {}), employeeId)
    assert.equal((await result).ok, false)
    const set = setRoles(() => answer(200, {}), [3], employeeId)
    assert.equal((await set.result).ok, false)
    assert.equal(calls.length + set.calls.length, 0)
  }
})

test('changing the roles: one POST with the employee and the roles, in the order chosen, and nothing else', async () => {
  const { calls, result } = setRoles(() => answer(200, { id: 41, planningRoles: 2, asked: 2 }))
  assert.deepEqual(await result, { ok: true, planningRoles: 2, asked: 2 })
  assert.equal(calls[0].url, 'http://odoo-gateway:8070/v1/actions/set_employee_planning_roles')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { employeeId: 41, planningRoleIds: [4, 3] })
  assert.deepEqual(await setRoles(() => answer(200, { id: 41, planningRoles: 0, asked: 0 }), []).result, { ok: true, planningRoles: 0, asked: 0 })
  const odd = await setRoles(() => answer(200, { id: 41, planningRoles: '2', asked: 2 })).result
  assert.equal(odd.ok, false, 'a 200 without a clear count is not trusted')
})

test('changing the roles: every refusal says that nothing was changed, and an unclear answer says what to do', async () => {
  const fail = async (reply: () => Response | Promise<Response>) => (await setRoles(reply).result) as { ok: false; message: string; notFound?: boolean }
  const gone = await fail(() => answer(404, { error: 'employee_not_found' }))
  assert.equal(gone.notFound, true)
  assert.match(gone.message, /niets gewijzigd/)
  for (const [reply, pattern] of [
    [() => answer(409, { error: 'planning_role_not_allowed', message: 'planning role 4 does not exist or is archived' }), /planningsrol bestaat niet/],
    [() => answer(429, { error: 'rate_limited' }), /te veel wijzigingen/],
    [() => answer(400, { error: 'invalid_planning_roles' }), /invalid_planning_roles/],
    [() => answer(502, { error: 'odoo_rejected', message: 'Klant Jansen bestaat al' }), /geweigerd/],
    [() => answer(401, { error: 'unauthorized' }), /token/],
    [() => answer(403, { error: 'action_not_allowed' }), /niet aan/],
  ] as const) {
    const result = await fail(reply)
    assert.match(result.message, pattern)
    assert.ok(!result.message.includes('Jansen'), 'text of Odoo is never passed on')
  }
  for (const reply of [() => answer(504, { error: 'outcome_unknown' }), () => answer(500, 'kapot'), () => { throw new TypeError('connection reset') }]) {
    const result = await fail(reply)
    assert.match(result.message, /opnieuw/)
    assert.match(result.message, /Open de medewerker in Odoo/)
  }
})
