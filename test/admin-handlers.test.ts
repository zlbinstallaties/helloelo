import test from 'node:test'
import assert from 'node:assert/strict'
import { GENERATED, ODOO, PASSWORD, dashboard, login, read, request, setup } from './api-helpers.ts'
import type { Api } from './api-helpers.ts'

const REQUEST = 'req-0123456789abcdef'

const plannerCookie = async (api: Api) => (await login(api, 'planner')).cookie
const monteurCookie = async (api: Api) => (await login(api, 'jan')).cookie

function addTechnician(api: Api, cookie: string | undefined, body: Record<string, unknown> = {}, init: { csrf?: boolean } = {}) {
  return api.handlers.employeesCreate(
    request('/api/employees', { method: 'POST', cookie, csrf: init.csrf, body: { requestId: REQUEST, name: 'Els Bakker', username: 'els', ...body } }),
  )
}

const accountCount = (api: Api) => api.accounts.list().length

// ---------------------------------------------------------------- Monteur toevoegen: POST /api/employees

test('add a technician: not logged in is refused, and neither Odoo nor any file is touched', async () => {
  const api = setup()
  const answer = await read(await addTechnician(api, undefined))
  assert.equal(answer.status, 401)
  assert.equal(api.odoo.calls.length, 0)
  assert.equal(api.journalState.text, null)
  assert.equal(accountCount(api), 2)
})

test('add a technician: a monteur with a login is refused too', async () => {
  const api = setup()
  const answer = await read(await addTechnician(api, await monteurCookie(api)))
  assert.equal(answer.status, 403)
  assert.equal(api.odoo.calls.length, 0)
  assert.equal(api.journalState.text, null)
  assert.equal(accountCount(api), 2)
})

test('add a technician: a forged request without the header of the dashboard is refused, also with a planner session', async () => {
  const api = setup()
  const answer = await read(await addTechnician(api, await plannerCookie(api), {}, { csrf: false }))
  assert.equal(answer.status, 403)
  assert.equal(api.odoo.calls.length, 0)
})

test('add a technician: a planner gets the employee id, the account linked to it, and the password once', async () => {
  const api = setup()
  const answer = await read(await addTechnician(api, await plannerCookie(api)))
  assert.equal(answer.status, 201)
  assert.equal(answer.json.employeeId, 41)
  assert.equal(answer.json.verified, true)
  assert.equal(answer.json.replayed, false)
  assert.equal(answer.json.password, GENERATED)
  assert.equal(answer.json.account.username, 'els')
  assert.equal(answer.json.account.role, 'monteur')
  assert.equal(answer.json.account.personId, 'employee:41')
  assert.deepEqual(api.odoo.calls, [{ requestId: REQUEST, name: 'Els Bakker' }], 'only the request id and the name go to Odoo')
  assert.ok(!answer.text.includes('scrypt'), 'no hash in the answer')
  assert.equal(answer.headers.get('cache-control'), 'no-store')
  assert.equal((await login(api, 'els', GENERATED)).response.status, 200, 'the technician can log in with that password')
})

test('add a technician: the technician then sees only their own planning, and nothing before they are planned', async () => {
  const api = setup()
  await addTechnician(api, await plannerCookie(api))
  const cookie = (await login(api, 'els', GENERATED)).cookie
  const seen = await dashboard(api, cookie, '?scope=all&date=2026-10-05')
  assert.equal(seen.status, 200)
  assert.deepEqual(seen.json.appointments, [])
})

test('add a technician: the browser cannot send company, responsible, user, model, method or values', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  for (const extra of [
    { company_id: 3 }, { companyId: 3 }, { responsibleUserId: 5 }, { hr_responsible_id: 5 }, { responsible: 5 },
    { user_id: 5 }, { userId: 5 }, { model: 'res.users' }, { method: 'write' }, { vals: { user_id: 5 } }, { role: 'admin' },
    { password: 'zelf-gekozen-wachtwoord' }, { personId: 'employee:7' }, { groups_id: [1] },
  ]) {
    const answer = await read(await addTechnician(api, cookie, extra))
    assert.equal(answer.status, 400, JSON.stringify(extra))
    assert.match(answer.json.error, /Onbekend veld/)
  }
  assert.equal(api.odoo.calls.length, 0)
  assert.equal(api.journalState.text, null)
  assert.equal(accountCount(api), 2)
})

test('add a technician: odd bodies are a clear error', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  for (const [body, status] of [['{ kapot', 400], ['[]', 400], ['null', 400], ['', 400], [JSON.stringify({ name: 'x'.repeat(40_000) }), 413]] as const) {
    const answer = await read(await api.handlers.employeesCreate(request('/api/employees', { method: 'POST', cookie, body })))
    assert.equal(answer.status, status, body.slice(0, 20))
  }
  const text = await read(await api.handlers.employeesCreate(new Request('http://dash.test/api/employees', { method: 'POST', headers: { cookie: cookie ?? '', 'x-dig-dashboard': '1', 'content-type': 'text/plain' }, body: '{}' })))
  assert.equal(text.status, 415)
  assert.equal(api.odoo.calls.length, 0)
})

test('add a technician: input is checked before Odoo is asked', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  for (const [extra, status] of [
    [{ username: 'jan' }, 409], [{ username: 'a b' }, 400], [{ name: '' }, 400], [{ name: 'Jan\nde Vries' }, 400],
    [{ requestId: 'kort' }, 400], [{ name: undefined }, 400], [{ username: undefined }, 400],
  ] as const) {
    const answer = await read(await addTechnician(api, cookie, extra))
    assert.equal(answer.status, status, JSON.stringify(extra))
  }
  assert.equal(api.odoo.calls.length, 0)
})

test('add a technician: whatever goes wrong at Odoo gives an error, no success, no password and no account', async () => {
  const outcomes = [
    [{ kind: 'rejected', message: 'Odoo heeft het aanmaken geweigerd. Er is niets aangemaakt.' }, 502],
    [{ kind: 'not_enabled', message: 'Het aanmaken van monteurs in Odoo staat niet aan op de server.' }, 503],
    [{ kind: 'unknown', message: 'Het is niet zeker of de medewerker is aangemaakt.' }, 504],
    [{ kind: 'invariant', id: 41, message: 'In Odoo is medewerker 41 aangemaakt, maar niet zoals bedoeld.' }, 500],
  ] as const
  for (const [outcome, status] of outcomes) {
    const api = setup()
    api.odoo.outcome = () => outcome
    const answer = await read(await addTechnician(api, await plannerCookie(api)))
    assert.equal(answer.status, status, outcome.kind)
    assert.ok(answer.json.error, outcome.kind)
    assert.equal(answer.json.retry, outcome.kind === 'unknown' || outcome.kind === 'invariant' ? 'blocked' : 'safe', outcome.kind)
    assert.equal(answer.json.password, undefined, outcome.kind)
    assert.equal(answer.json.account, undefined, outcome.kind)
    assert.equal(accountCount(api), 2, `${outcome.kind}: no account was made`)
    assert.equal(api.accounts.list().some((account) => account.username === 'els'), false)
  }
})

test('add a technician: an Odoo that fails by surprise is an error too, and makes no account', async () => {
  const api = setup()
  api.odoo.outcome = () => {
    throw new Error('boem')
  }
  const answer = await read(await addTechnician(api, await plannerCookie(api)))
  assert.equal(answer.status, 500)
  assert.equal(answer.json.password, undefined)
  assert.equal(accountCount(api), 2)
})

test('add a technician: repeating the request gives the same employee, without a second call or a second account', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const first = await read(await addTechnician(api, cookie))
  const again = await read(await addTechnician(api, cookie))
  assert.equal(again.status, 200)
  assert.equal(again.json.replayed, true)
  assert.equal(again.json.employeeId, first.json.employeeId)
  assert.equal(again.json.password, null)
  assert.equal(again.json.account.id, first.json.account.id)
  assert.equal(api.odoo.calls.length, 1)
  assert.equal(accountCount(api), 3)
})

test('add a technician: after a lost answer a repeat with an unclear outcome is not sent to Odoo again', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  api.odoo.outcome = () => ({ kind: 'unknown', message: 'Het is niet zeker of de medewerker is aangemaakt.' })
  assert.equal((await read(await addTechnician(api, cookie))).status, 504)
  for (let i = 0; i < 3; i++) assert.equal((await read(await addTechnician(api, cookie))).status, 409)
  assert.equal(api.odoo.calls.length, 1)
  assert.equal(accountCount(api), 2)
})

test('add a technician: the list of accounts is up to date afterwards', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const before = await read(await api.handlers.accountsList(request('/api/accounts', { cookie })))
  assert.equal(before.json.accounts.length, 2)
  await addTechnician(api, cookie)
  const after = await read(await api.handlers.accountsList(request('/api/accounts', { cookie })))
  assert.equal(after.json.accounts.length, 3)
  const els = after.json.accounts.find((account: { username: string }) => account.username === 'els')
  assert.equal(els.personId, 'employee:41')
  assert.equal(els.personInPlanning, false, 'not planned in Odoo yet: the planner does that in Odoo Planning')
})

test('add a technician: with logins off or not set up it does nothing', async () => {
  for (const [options, status] of [[{ mode: 'off' }, 404], [{ configured: false }, 503]] as const) {
    const api = setup(options)
    const answer = await read(await addTechnician(api, undefined))
    assert.equal(answer.status, status)
    assert.equal(api.odoo.calls.length, 0)
  }
})

test('add a technician: the planner from the server settings (emergency admin) may do it, and is in the journal', async () => {
  const api = setup()
  const cookie = (await login(api, 'noodadmin', 'noodwachtwoord-van-de-server')).cookie
  assert.equal((await read(await addTechnician(api, cookie))).status, 201)
  assert.equal(api.journal.get(REQUEST)?.by, 'emergency')
})

// ---------------------------------------------------------------- accounts

test('accounts: every part is for admins only', async () => {
  const api = setup()
  const jan = await monteurCookie(api)
  const id = api.accounts.list()[0].id
  const calls = [
    () => api.handlers.accountsList(request('/api/accounts', { cookie: jan })),
    () => api.handlers.accountsCreate(request('/api/accounts', { method: 'POST', cookie: jan, body: { username: 'x', name: 'X' } })),
    () => api.handlers.accountsUpdate(request(`/api/accounts/${id}`, { method: 'PATCH', cookie: jan, body: { name: 'X' } }), id),
    () => api.handlers.accountsResetPassword(request(`/api/accounts/${id}/password`, { method: 'POST', cookie: jan }), id),
    () => api.handlers.accountsRemove(request(`/api/accounts/${id}`, { method: 'DELETE', cookie: jan }), id),
  ]
  for (const call of calls) assert.equal((await read(await call())).status, 403)
  const anonymous = await read(await api.handlers.accountsList(request('/api/accounts')))
  assert.equal(anonymous.status, 401)
  assert.equal(accountCount(api), 2)
})

test('accounts: the list shows who is linked to whom in the planning, and who can be linked', async () => {
  const api = setup()
  const answer = await read(await api.handlers.accountsList(request('/api/accounts', { cookie: await plannerCookie(api) })))
  assert.equal(answer.status, 200)
  const jan = answer.json.accounts.find((account: { username: string }) => account.username === 'jan')
  assert.equal(jan.personInPlanning, true)
  assert.equal(jan.personName, 'Jan')
  assert.deepEqual(answer.json.persons.map((p: { value: string; hasAccount: boolean }) => [p.value, p.hasAccount]), [['employee:7', true], ['employee:8', false]])
  assert.equal(typeof answer.json.currentUserId, 'string')
  assert.equal(answer.json.planningError, null)
  assert.ok(!answer.text.includes('scrypt'))
})

test('accounts: when the planning cannot be read the accounts are still listed, with the reason', async () => {
  const api = setup()
  api.control.failWith = new Error('Odoo-gateway is niet bereikbaar.')
  const answer = await read(await api.handlers.accountsList(request('/api/accounts', { cookie: await plannerCookie(api) })))
  assert.equal(answer.status, 200)
  assert.equal(answer.json.accounts.length, 2)
  assert.deepEqual(answer.json.persons, [])
  assert.match(answer.json.planningError, /niet bereikbaar/)
})

test('accounts: link a new technician account to a person in the planning', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const answer = await read(await api.handlers.accountsCreate(request('/api/accounts', { method: 'POST', cookie, body: { username: 'sanne', name: 'Sanne Bakker', personId: 'employee:8' } })))
  assert.equal(answer.status, 201)
  assert.equal(answer.json.password, GENERATED)
  assert.equal(answer.json.account.personId, 'employee:8')
  assert.equal(answer.json.account.role, 'monteur')
  assert.equal(api.odoo.calls.length, 0, 'nothing is asked of Odoo to link an existing person')
  const cookieSanne = (await login(api, 'sanne', GENERATED)).cookie
  const day = await dashboard(api, cookieSanne, '?scope=day&date=2026-10-05')
  assert.deepEqual(day.json.appointments.map((a: { id: string }) => a.id).sort(), ['slot-2', 'slot-3'])
  const all = await dashboard(api, cookieSanne, '?scope=all&date=2026-10-05')
  assert.deepEqual(all.json.appointments.map((a: { id: string }) => a.id).sort(), ['slot-2', 'slot-3', 'slot-4'])
})

test('accounts: a person must exist in the planning and have no account yet', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const create = async (body: Record<string, unknown>) => read(await api.handlers.accountsCreate(request('/api/accounts', { method: 'POST', cookie, body })))
  assert.equal((await create({ username: 'x1x', name: 'X', personId: 'employee:999' })).status, 400)
  assert.equal((await create({ username: 'x1x', name: 'X', personId: 'name:Jan' })).status, 400)
  assert.equal((await create({ username: 'x1x', name: 'X' })).status, 400)
  assert.equal((await create({ username: 'x1x', name: 'X', personId: 'employee:7' })).status, 409)
  assert.equal((await create({ username: 'jan', name: 'X', personId: 'employee:8' })).status, 409)
  assert.equal(accountCount(api), 2)
})

test('accounts: an admin account needs no person; nothing else can be set', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const created = await read(await api.handlers.accountsCreate(request('/api/accounts', { method: 'POST', cookie, body: { username: 'beheer2', name: 'Beheer Twee', role: 'admin' } })))
  assert.equal(created.status, 201)
  assert.equal(created.json.account.role, 'admin')
  assert.equal(created.json.account.personId, null)
  for (const extra of [{ passwordHash: 'x' }, { sessionVersion: 9 }, { id: 'u_x' }, { password: 'zelf-gekozen-wachtwoord' }, { disabled: true }]) {
    const answer = await read(await api.handlers.accountsCreate(request('/api/accounts', { method: 'POST', cookie, body: { username: 'x1x', name: 'X', role: 'admin', ...extra } })))
    assert.equal(answer.status, 400, JSON.stringify(extra))
  }
})

test('accounts: change a name, a person, or disable another account; that account is out at once', async () => {
  const api = setup()
  const planner = await plannerCookie(api)
  const jan = await monteurCookie(api)
  const id = api.accounts.list().find((account) => account.username === 'jan')!.id
  const patch = async (body: Record<string, unknown>) => read(await api.handlers.accountsUpdate(request(`/api/accounts/${id}`, { method: 'PATCH', cookie: planner, body }), id))
  assert.equal((await patch({ name: 'Jan V.' })).json.account.name, 'Jan V.')
  assert.equal((await dashboard(api, jan)).status, 200, 'a new display name keeps the session')
  assert.equal((await patch({ disabled: true })).json.account.disabled, true)
  assert.equal((await dashboard(api, jan)).status, 401)
  assert.equal((await patch({ disabled: false })).status, 200)
  assert.equal((await patch({ personId: 'employee:8' })).json.account.personId, 'employee:8')
  assert.equal((await patch({ personId: 'employee:999' })).status, 400)
  assert.equal((await patch({ passwordHash: 'x' })).status, 400)
  assert.equal((await patch({ sessionVersion: 0 })).status, 400)
  const missing = await read(await api.handlers.accountsUpdate(request('/api/accounts/u_nope', { method: 'PATCH', cookie: planner, body: { name: 'X' } }), 'u_nope'))
  assert.equal(missing.status, 404)
})

test('accounts: an admin cannot disable, demote or remove themselves', async () => {
  const api = setup()
  const planner = await plannerCookie(api)
  const id = api.accounts.list().find((account) => account.username === 'planner')!.id
  const patch = async (body: Record<string, unknown>) => read(await api.handlers.accountsUpdate(request(`/api/accounts/${id}`, { method: 'PATCH', cookie: planner, body }), id))
  assert.equal((await patch({ disabled: true })).status, 400)
  assert.equal((await patch({ role: 'monteur', personId: 'employee:8' })).status, 400)
  assert.equal((await patch({ name: 'Petra P.' })).status, 200, 'the name may change')
  const removed = await read(await api.handlers.accountsRemove(request(`/api/accounts/${id}`, { method: 'DELETE', cookie: planner }), id))
  assert.equal(removed.status, 400)
  const reset = await read(await api.handlers.accountsResetPassword(request(`/api/accounts/${id}/password`, { method: 'POST', cookie: planner }), id))
  assert.equal(reset.status, 400)
  assert.equal(api.accounts.get(id)?.disabled, false)
})

test('accounts: a new password for someone else is shown once and ends their sessions', async () => {
  const api = setup()
  const planner = await plannerCookie(api)
  const jan = await monteurCookie(api)
  const id = api.accounts.list().find((account) => account.username === 'jan')!.id
  const answer = await read(await api.handlers.accountsResetPassword(request(`/api/accounts/${id}/password`, { method: 'POST', cookie: planner }), id))
  assert.equal(answer.status, 200)
  assert.equal(answer.json.password, GENERATED)
  assert.equal((await dashboard(api, jan)).status, 401)
  assert.equal((await login(api, 'jan', PASSWORD, '10.2.2.2')).response.status, 401)
  assert.equal((await login(api, 'jan', GENERATED, '10.2.2.3')).response.status, 200)
  const nobody = await read(await api.handlers.accountsResetPassword(request('/api/accounts/u_nope/password', { method: 'POST', cookie: planner }), 'u_nope'))
  assert.equal(nobody.status, 404)
})

test('accounts: removing an account removes the login at once', async () => {
  const api = setup()
  const planner = await plannerCookie(api)
  const jan = await monteurCookie(api)
  const id = api.accounts.list().find((account) => account.username === 'jan')!.id
  const answer = await read(await api.handlers.accountsRemove(request(`/api/accounts/${id}`, { method: 'DELETE', cookie: planner }), id))
  assert.equal(answer.status, 200)
  assert.equal((await dashboard(api, jan)).status, 401)
  assert.equal((await read(await api.handlers.accountsRemove(request(`/api/accounts/${id}`, { method: 'DELETE', cookie: planner }), id))).status, 404)
})

test('accounts: every change needs the header of the dashboard', async () => {
  const api = setup()
  const planner = await plannerCookie(api)
  const id = api.accounts.list().find((account) => account.username === 'jan')!.id
  const bare = [
    () => api.handlers.accountsCreate(request('/api/accounts', { method: 'POST', cookie: planner, csrf: false, body: { username: 'x1x', name: 'X', role: 'admin' } })),
    () => api.handlers.accountsUpdate(request(`/api/accounts/${id}`, { method: 'PATCH', cookie: planner, csrf: false, body: { name: 'X' } }), id),
    () => api.handlers.accountsResetPassword(request(`/api/accounts/${id}/password`, { method: 'POST', cookie: planner, csrf: false }), id),
    () => api.handlers.accountsRemove(request(`/api/accounts/${id}`, { method: 'DELETE', cookie: planner, csrf: false }), id),
  ]
  for (const call of bare) assert.equal((await read(await call())).status, 403)
  assert.equal(accountCount(api), 2)
})

test('accounts: with logins off there are no accounts to manage', async () => {
  const api = setup({ mode: 'off' })
  assert.equal((await read(await api.handlers.accountsList(request('/api/accounts')))).status, 404)
  assert.equal((await read(await api.handlers.accountsCreate(request('/api/accounts', { method: 'POST', body: { username: 'x1x', name: 'X' } })))).status, 404)
})

test('the pages that were already there still answer with a planner session', async () => {
  const api = setup()
  const answer = await dashboard(api, await plannerCookie(api), '?scope=all&date=2026-10-05')
  assert.equal(answer.status, 200)
  assert.ok(answer.text.includes(ODOO))
})
