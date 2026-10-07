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
const removePeriod = (api: Api, cookie: string | undefined, id: string, init: { csrf?: boolean } = {}) =>
  api.handlers.availabilityRemove(request(`/api/availability/${id}`, { method: 'DELETE', cookie, csrf: init.csrf }), id)
const janId = (api: Api) => api.accounts.list().find((account) => account.username === 'jan')?.id as string

test('a technician gives a period he is not available, and it is kept for his own account', async () => {
  const api = setup()
  const cookie = await jan(api)
  const added = await read(await addPeriod(api, cookie, { from: '2026-10-12', to: '2026-10-16', note: 'Vakantie' }))
  assert.equal(added.status, 201)
  assert.deepEqual(Object.keys(added.json), ['period'])
  assert.deepEqual({ ...added.json.period, id: '' }, { id: '', from: '2026-10-12', to: '2026-10-16', note: 'Vakantie' })
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
