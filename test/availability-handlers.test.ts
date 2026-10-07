import assert from 'node:assert/strict'
import test from 'node:test'
import { PASSWORD, login, read, request, setup } from './api-helpers.ts'
import type { Api } from './api-helpers.ts'

const jan = async (api: Api) => (await login(api, 'jan')).cookie
const planner = async (api: Api) => (await login(api, 'planner')).cookie
const sanne = async (api: Api) => {
  if (!api.accounts.list().some((account) => account.username === 'sanne')) {
    api.accounts.create({ username: 'sanne', name: 'Sanne Smit', role: 'monteur', personId: 'employee:8', password: PASSWORD })
  }
  return (await login(api, 'sanne')).cookie
}

const list = (api: Api, cookie?: string) => api.handlers.availabilityList(request('/api/availability', { cookie }))
const addPeriod = (api: Api, cookie: string | undefined, body: unknown, init: { csrf?: boolean } = {}) =>
  api.handlers.availabilityAdd(request('/api/availability', { method: 'POST', cookie, body, csrf: init.csrf }))
const retryPeriod = (api: Api, cookie: string | undefined, id: string, init: { csrf?: boolean } = {}) =>
  api.handlers.availabilityRetry(request(`/api/availability/${id}/retry`, { method: 'POST', cookie, csrf: init.csrf }), id)
const removePeriod = (api: Api, cookie: string | undefined, id: string, init: { csrf?: boolean } = {}) =>
  api.handlers.availabilityRemove(request(`/api/availability/${id}`, { method: 'DELETE', cookie, csrf: init.csrf }), id)
const janId = (api: Api) => api.accounts.list().find((account) => account.username === 'jan')?.id as string

test('a technician gives a period he is not available, and it is kept for his own account', async () => {
  const api = setup()
  const cookie = await jan(api)
  const added = await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-16', note: 'Vakantie' }))
  assert.equal(added.status, 201)
  assert.deepEqual(Object.keys(added.json), ['period'])
  assert.deepEqual({ ...added.json.period, id: '' }, { id: '', from: '2026-10-12', to: '2026-10-16', note: 'Vakantie', odoo: { state: 'synced', verified: true } })
  assert.match(added.json.period.id, /^p_[0-9a-f]{32}$/)
  assert.deepEqual(api.availability.list().map((period) => [period.accountId, period.from, period.to, period.note]), [[janId(api), '2026-10-12', '2026-10-16', 'Vakantie']])
  const noNote = await read(await addPeriod(api, cookie, { from: '2026-10-20', to: '2026-10-20' }))
  assert.equal(noNote.status, 201)
  assert.equal(noNote.json.period.note, '')
})

test('a technician sees only his own periods that have not ended, and the screen knows he may change them', async () => {
  const api = setup()
  const own = await jan(api)
  const other = await sanne(api)
  await addPeriod(api, own, { from: '2026-10-12', to: '2026-10-13', note: 'Jan' })
  await addPeriod(api, own, { from: '2026-10-07', to: '2026-10-08', note: 'loopt nog' })
  await addPeriod(api, other, { from: '2026-10-12', to: '2026-10-13', note: 'Sanne' })
  api.availabilityClock.now = new Date('2026-10-09T10:00:00Z') // the second ended yesterday
  const answer = await read(await list(api, own))
  assert.equal(answer.status, 200)
  assert.equal(answer.json.canEdit, true)
  assert.equal(answer.json.today, '2026-10-09')
  assert.deepEqual(answer.json.periods.map((period: { note: string; name: string }) => [period.note, period.name]), [['Jan', 'Jan de Vries']])
  assert.equal(answer.headers.get('cache-control'), 'no-store')
  assert.ok(!JSON.stringify(answer.json).includes('Sanne'), 'nothing of the other technician')
})

test('the planner sees every technician, in the order of the dates, and can not change anything', async () => {
  const api = setup()
  const cookie = await planner(api)
  await addPeriod(api, await jan(api), { from: '2026-10-20', to: '2026-10-21', note: 'later' })
  await addPeriod(api, await sanne(api), { from: '2026-10-12', to: '2026-10-13', note: 'eerst' })
  const answer = await read(await list(api, cookie))
  assert.equal(answer.status, 200)
  assert.equal(answer.json.canEdit, false)
  assert.deepEqual(answer.json.periods.map((period: { note: string; name: string }) => [period.note, period.name]), [['eerst', 'Sanne Smit'], ['later', 'Jan de Vries']])

  const id = answer.json.periods[0].id as string
  const added = await read(await addPeriod(api, cookie, { from: '2026-11-02', to: '2026-11-03' }))
  assert.equal(added.status, 403)
  assert.match(added.json.error, /monteur/)
  assert.equal((await read(await removePeriod(api, cookie, id))).status, 403)
  assert.equal(api.availability.list().length, 2, 'nothing changed')
})

test('nobody without a login, without the header of the dashboard, or with logins off', async () => {
  const api = setup()
  assert.equal((await read(await list(api, undefined))).status, 401)
  assert.equal((await read(await addPeriod(api, undefined, { from: '2026-10-12', to: '2026-10-12' }))).status, 401)
  assert.equal((await read(await removePeriod(api, undefined, 'p_1'))).status, 401)
  const cookie = await jan(api)
  assert.equal((await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-12' }, { csrf: false }))).status, 403)
  const kept = await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-12' }))
  assert.equal((await read(await removePeriod(api, cookie, kept.json.period.id, { csrf: false }))).status, 403)
  assert.equal(api.availability.list().length, 1)

  const off = setup({ mode: 'off' })
  assert.equal((await read(await list(off, undefined))).status, 404)
  assert.equal((await read(await addPeriod(off, undefined, { from: '2026-10-12', to: '2026-10-12' }))).status, 404)
  assert.equal((await read(await removePeriod(off, undefined, 'p_1'))).status, 404)
  const unset = setup({ configured: false })
  assert.equal((await read(await list(unset, undefined))).status, 503)
})

test('only the fields from, to and note are accepted: not an account, a person, an id or anything of Odoo', async () => {
  const api = setup()
  const cookie = await jan(api)
  for (const extra of [{ accountId: 'u_x' }, { personId: 'employee:99' }, { employeeId: 99 }, { id: 'p_1' }, { odoo: { leaveId: 1 } }, { createdAt: '2020-01-01' }]) {
    const refused = await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-12', ...extra }))
    assert.equal(refused.status, 400, JSON.stringify(extra))
    assert.match(refused.json.error, /Onbekend veld/)
  }
  assert.deepEqual(api.availability.list(), [], 'nothing was kept')
  const textBody = await read(await api.handlers.availabilityAdd(request('/api/availability', { method: 'POST', cookie, body: 'geen json' })))
  assert.equal(textBody.status, 400)
})

test('wrong dates are a clear 400, an overlap or too many is a 409, and nothing is kept', async () => {
  const api = setup()
  const cookie = await jan(api)
  for (const body of [{}, { from: '2026-10-12' }, { from: '12-10-2026', to: '2026-10-13' }, { from: '2026-10-14', to: '2026-10-13' }, { from: '2026-10-01', to: '2026-10-05' }, { from: '2026-10-12', to: '2026-10-13', note: 'x'.repeat(201) }, { from: '2026-10-12', to: '2026-10-13', note: 'a\nb' }]) {
    const refused = await read(await addPeriod(api, cookie, body))
    assert.equal(refused.status, 400, JSON.stringify(body))
    assert.equal(typeof refused.json.error, 'string')
  }
  assert.deepEqual(api.availability.list(), [])
  await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-16' })
  const overlap = await read(await addPeriod(api, cookie, { from: '2026-10-14', to: '2026-10-20' }))
  assert.equal(overlap.status, 409)
  assert.match(overlap.json.error, /overlapt/)
  const again = await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-16' }))
  assert.equal(again.status, 409, 'a double click gives the same period twice: the second is refused')
  assert.equal(api.availability.list().length, 1)
})

test('a technician removes his own period, and nobody else does', async () => {
  const api = setup()
  const own = await jan(api)
  const other = await sanne(api)
  const mine = (await read(await addPeriod(api, own, { from: '2026-10-12', to: '2026-10-13' }))).json.period.id as string
  const theirs = (await read(await addPeriod(api, other, { from: '2026-10-12', to: '2026-10-13' }))).json.period.id as string
  assert.equal((await read(await removePeriod(api, own, theirs))).status, 404, "someone else's period looks like it does not exist")
  assert.equal((await read(await removePeriod(api, own, 'p_bestaat_niet'))).status, 404)
  assert.equal(api.availability.list().length, 2)
  const removed = await read(await removePeriod(api, own, mine))
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.json, { ok: true })
  assert.deepEqual(api.availability.list().map((period) => period.id), [theirs])
  assert.equal((await read(await removePeriod(api, own, mine))).status, 404, 'a second time is not found, not an error')
})

test('when the planner removes an account, the periods of that technician go with it', async () => {
  const api = setup()
  await addPeriod(api, await jan(api), { from: '2026-10-12', to: '2026-10-13' })
  await addPeriod(api, await sanne(api), { from: '2026-10-12', to: '2026-10-13' })
  const removed = await api.handlers.accountsRemove(request(`/api/accounts/${janId(api)}`, { method: 'DELETE', cookie: await planner(api) }), janId(api))
  assert.equal(removed.status, 200)
  assert.deepEqual(api.availability.list().map((period) => period.accountId === janId(api)), [false])
})

test('periods of an account that no longer exists are not shown to the planner', async () => {
  const api = setup()
  await addPeriod(api, await jan(api), { from: '2026-10-12', to: '2026-10-13', note: 'spook' })
  api.accounts.remove(janId(api)) // removed behind the back of the availability (file edited by hand, older version)
  const answer = await read(await list(api, await planner(api)))
  assert.deepEqual(answer.json.periods, [])
})

test('a damaged availability file is a clear error and is never overwritten', async () => {
  const api = setup()
  const cookie = await jan(api)
  api.availabilityState.text = '{ kapot'
  const listed = await read(await list(api, cookie))
  assert.equal(listed.status, 500)
  assert.match(listed.json.error, /beschikbaarheidsbestand/)
  assert.equal((await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-12' }))).status, 500)
  assert.equal(api.availabilityState.text, '{ kapot')
})

// ---------------------------------------------------------------- the record in Odoo

const stored = (api: Api) => api.availability.list()

test('a period of a technician who is an Odoo employee is sent to Odoo: with the period id as request id, and what Odoo confirms is kept', async () => {
  const api = setup()
  const added = await read(await addPeriod(api, await jan(api), { from: '2026-10-12', to: '2026-10-13', note: 'Vakantie' }))
  assert.equal(added.status, 201)
  const id = added.json.period.id as string
  assert.deepEqual(api.odoo.away.adds, [{ requestId: id, employeeId: 7, from: '2026-10-12', to: '2026-10-13', note: 'Vakantie' }])
  assert.deepEqual(stored(api)[0].odoo, { employeeId: 7, state: 'synced', leaveId: 901, verified: true })
  assert.deepEqual(added.json.period.odoo, { state: 'synced', verified: true })
  assert.ok(!JSON.stringify(added.json).includes('901'), 'the record number of Odoo is not sent to the browser')
})

test('a technician that is not an Odoo employee, or a gateway without the action, keeps the period in the dashboard only', async () => {
  const api = setup()
  api.accounts.create({ username: 'naam', name: 'Piet', role: 'monteur', personId: 'name:piet', password: PASSWORD })
  const byName = await read(await addPeriod(api, (await login(api, 'naam')).cookie, { from: '2026-10-12', to: '2026-10-12' }))
  assert.equal(byName.status, 201)
  assert.deepEqual(byName.json.period.odoo, { state: 'none' })
  assert.equal(api.odoo.away.adds.length, 0, 'nobody to mark in Odoo')

  // An account that carries a number too long for an Odoo id is not cut off into another employee's number.
  api.accounts.create({ username: 'te.lang', name: 'Lang', role: 'monteur', personId: 'employee:12345678901', password: PASSWORD })
  const tooLong = await read(await addPeriod(api, (await login(api, 'te.lang')).cookie, { from: '2026-10-12', to: '2026-10-12' }))
  assert.deepEqual(tooLong.json.period.odoo, { state: 'none' })
  assert.equal(api.odoo.away.adds.length, 0)

  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'not_enabled', message: 'staat niet aan' })
  const off = await read(await addPeriod(api, await jan(api), { from: '2026-10-12', to: '2026-10-12' }))
  assert.equal(off.status, 201)
  assert.deepEqual(off.json.period.odoo, { state: 'none' })
  assert.equal(api.odoo.away.adds.length, 1, 'asked once; the answer was "not switched on"')
  assert.equal(stored(api).find((period) => period.id === off.json.period.id)?.odoo, undefined)
})

test('Odoo refuses: the period is kept and says so; no usable answer: it says it is not certain', async () => {
  const api = setup()
  const cookie = await jan(api)
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'rejected', message: 'Odoo heeft het geweigerd (AccessError). De periode is niet naar Odoo gestuurd.' })
  const refused = await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-12' }))
  assert.equal(refused.status, 201, 'the technician gave it, so it stays in the dashboard')
  assert.deepEqual(refused.json.period.odoo, { state: 'failed', message: 'Odoo heeft het geweigerd (AccessError). De periode is niet naar Odoo gestuurd.' })
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'unknown', message: 'Het is niet zeker of deze periode in Odoo staat.' })
  const unclear = await read(await addPeriod(api, cookie, { from: '2026-10-14', to: '2026-10-14' }))
  assert.deepEqual(unclear.json.period.odoo, { state: 'unknown', message: 'Het is niet zeker of deze periode in Odoo staat.' })
  assert.deepEqual(stored(api).map((period) => [period.odoo?.state, period.odoo?.employeeId]), [['failed', 7], ['unknown', 7]])
})

test('the list shows the state of every period, to the technician and to the planner', async () => {
  const api = setup()
  const cookie = await jan(api)
  await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-12' })
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'rejected', message: 'Geweigerd.' })
  await addPeriod(api, cookie, { from: '2026-10-14', to: '2026-10-14' })
  for (const who of [cookie, await planner(api)]) {
    const answer = await read(await list(api, who))
    assert.deepEqual(answer.json.periods.map((period: { odoo: unknown }) => period.odoo), [{ state: 'synced', verified: true }, { state: 'failed', message: 'Geweigerd.' }])
    assert.ok(!JSON.stringify(answer.json).includes('leaveId'))
  }
})

test('trying again: a period that was refused, or never sent, is sent again with the same request id; otherwise it is not', async () => {
  const api = setup()
  const cookie = await jan(api)
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'rejected', message: 'Geweigerd.' })
  const added = await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-13', note: 'Vakantie' }))
  const id = added.json.period.id as string
  api.odoo.away.addAnswer = () => ({ ok: true, leaveId: 902, verified: true })
  const again = await read(await retryPeriod(api, cookie, id))
  assert.equal(again.status, 200)
  assert.deepEqual(again.json.period.odoo, { state: 'synced', verified: true })
  assert.deepEqual(api.odoo.away.adds.map((call) => call.requestId), [id, id], 'the same request id: the gateway never makes it twice')
  assert.deepEqual(stored(api)[0].odoo, { employeeId: 7, state: 'synced', leaveId: 902, verified: true })

  const done = await read(await retryPeriod(api, cookie, id))
  assert.equal(done.status, 409, 'it is in Odoo already')
  assert.equal(api.odoo.away.adds.length, 2)

  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'unknown', message: 'Niet zeker.' })
  const unsure = (await read(await addPeriod(api, cookie, { from: '2026-10-20', to: '2026-10-20' }))).json.period.id as string
  const blocked = await read(await retryPeriod(api, cookie, unsure))
  assert.equal(blocked.status, 409, 'it may exist: not sent again')
  assert.match(blocked.json.error, /planner|Odoo/)
  assert.equal(api.odoo.away.adds.length, 3)
})

test('trying again for a period that never went to Odoo, because the action was off: sent now, and still off is a clear answer', async () => {
  const api = setup()
  const cookie = await jan(api)
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'not_enabled', message: 'staat niet aan' })
  const id = (await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-13' }))).json.period.id as string
  const still = await read(await retryPeriod(api, cookie, id))
  assert.equal(still.status, 409)
  assert.match(still.json.error, /staat niet aan/)
  api.odoo.away.addAnswer = () => ({ ok: true, leaveId: 903, verified: true })
  const now = await read(await retryPeriod(api, cookie, id))
  assert.equal(now.status, 200)
  assert.equal(now.json.period.odoo.state, 'synced')
})

test('trying again: only the technician, only his own, and only when he is an Odoo employee', async () => {
  const api = setup()
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'rejected', message: 'Geweigerd.' })
  const own = await jan(api)
  const other = await sanne(api)
  const id = (await read(await addPeriod(api, own, { from: '2026-10-12', to: '2026-10-13' }))).json.period.id as string
  assert.equal((await read(await retryPeriod(api, undefined, id))).status, 401)
  assert.equal((await read(await retryPeriod(api, own, id, { csrf: false }))).status, 403)
  assert.equal((await read(await retryPeriod(api, await planner(api), id))).status, 403)
  assert.equal((await read(await retryPeriod(api, other, id))).status, 404, 'the period of someone else looks like it does not exist')
  assert.equal((await read(await retryPeriod(api, own, 'p_bestaat_niet'))).status, 404)
  api.accounts.create({ username: 'naam', name: 'Piet', role: 'monteur', personId: 'name:piet', password: PASSWORD })
  const byName = (await login(api, 'naam')).cookie
  const named = (await read(await addPeriod(api, byName, { from: '2026-10-12', to: '2026-10-13' }))).json.period.id as string
  assert.equal((await read(await retryPeriod(api, byName, named))).status, 400)
  assert.equal(api.odoo.away.adds.length, 1, 'none of these reached the gateway')
  const off = setup({ mode: 'off' })
  assert.equal((await read(await retryPeriod(off, undefined, 'p_1'))).status, 404)
})

test('removing a period that is in Odoo removes the record there first, using what was kept, not what the browser says', async () => {
  const api = setup()
  const cookie = await jan(api)
  const id = (await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-13' }))).json.period.id as string
  // The technician is linked to another employee afterwards; the record that was made is still removed for the employee it was made for.
  api.accounts.update(janId(api), { personId: 'employee:8' })
  const removed = await read(await removePeriod(api, (await login(api, 'jan')).cookie, id))
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.json, { ok: true })
  assert.deepEqual(api.odoo.away.removes, [{ employeeId: 7, leaveId: 901 }])
  assert.deepEqual(stored(api), [])
})

test('removing: when Odoo refuses, is silent or the action is off, the period stays, and removing again is allowed', async () => {
  const api = setup()
  const cookie = await jan(api)
  const id = (await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-13' }))).json.period.id as string
  const cases: Array<[() => any, number, RegExp]> = [
    [() => ({ ok: false, kind: 'rejected', message: 'Odoo heeft het verwijderen geweigerd. Er is niets verwijderd.' }), 502, /geweigerd/],
    [() => ({ ok: false, kind: 'unknown', message: 'Niet zeker of de periode uit Odoo is verwijderd; probeer het opnieuw.' }), 504, /opnieuw/],
    [() => ({ ok: false, kind: 'not_enabled', message: 'staat niet aan' }), 409, /Odoo/],
  ]
  for (const [answer, status, message] of cases) {
    api.odoo.away.removeAnswer = answer
    const refused = await read(await removePeriod(api, cookie, id))
    assert.equal(refused.status, status)
    assert.match(refused.json.error, message)
    assert.equal(stored(api).length, 1, 'the period is still there')
  }
  api.odoo.away.removeAnswer = () => ({ ok: true, removed: false })
  assert.equal((await read(await removePeriod(api, cookie, id))).status, 200, 'already gone in Odoo: gone here too')
  assert.deepEqual(stored(api), [])
})

test('removing a period that never reached Odoo, or failed, asks Odoo nothing; one that may exist says so', async () => {
  const api = setup()
  const cookie = await jan(api)
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'rejected', message: 'Geweigerd.' })
  const failed = (await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-12' }))).json.period.id as string
  assert.deepEqual(await read(await removePeriod(api, cookie, failed)).then((answer) => answer.json), { ok: true })
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'not_enabled', message: 'x' })
  const none = (await read(await addPeriod(api, cookie, { from: '2026-10-14', to: '2026-10-14' }))).json.period.id as string
  assert.equal((await read(await removePeriod(api, cookie, none))).status, 200)
  api.odoo.away.addAnswer = () => ({ ok: false, kind: 'unknown', message: 'Niet zeker.' })
  const unsure = (await read(await addPeriod(api, cookie, { from: '2026-10-16', to: '2026-10-16' }))).json.period.id as string
  const answer = await read(await removePeriod(api, cookie, unsure))
  assert.equal(answer.status, 200)
  assert.match(answer.json.warning, /niet zeker/i)
  assert.equal(api.odoo.away.removes.length, 0)
  assert.deepEqual(stored(api), [])
})
