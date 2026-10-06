import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmployeeViaGateway } from '../src/lib/gateway-employee.ts'
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

test('Odoo confirmed: the id, whether it was verified, and whether this was a repeat', async () => {
  assert.deepEqual(await run(() => answer(200, { id: 41, name: 'Jan', verified: true })).outcome, { kind: 'created', id: 41, verified: true, replayed: false })
  assert.deepEqual(await run(() => answer(200, { id: 41, name: 'Jan', verified: false })).outcome, { kind: 'created', id: 41, verified: false, replayed: false })
  assert.deepEqual(await run(() => answer(200, { id: 41, name: 'Jan', verified: true, replayed: true })).outcome, { kind: 'created', id: 41, verified: true, replayed: true })
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
