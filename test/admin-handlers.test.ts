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
  assert.equal(answer.json.planningRoles, 0, 'no planning role was confirmed: the screen must say so')
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
    { planning_role_ids: [[6, 0, [1]]] }, { defaultPlanningRoleId: 1 }, { roleId: 1 },
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

test('add a technician: the answer tells how many planning roles Odoo confirmed', async () => {
  const api = setup()
  api.odoo.outcome = () => ({ kind: 'created', id: 41, verified: true, planningRoles: 2, replayed: false })
  const answer = await read(await addTechnician(api, await plannerCookie(api)))
  assert.equal(answer.status, 201)
  assert.equal(answer.json.planningRoles, 2)
})

test('add a technician: the planning roles chosen go to the gateway, and a wrong choice is a clear error', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const answer = await read(await addTechnician(api, cookie, { planningRoleIds: [4, 3] }))
  assert.equal(answer.status, 201)
  assert.deepEqual(api.odoo.calls, [{ requestId: REQUEST, name: 'Els Bakker', planningRoleIds: [4, 3] }])
  const bad = await read(await addTechnician(api, cookie, { requestId: 'req-other-0123456789ab', username: 'els2', planningRoleIds: [0] }))
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /planningsrollen/)
  assert.equal(api.odoo.calls.length, 1)
})

test('planning roles: only a logged-in admin gets the list, with logins off there is none, and a gateway problem is a clear error', async () => {
  const listRoles = (api: Api, cookie: string | undefined) => api.handlers.planningRolesList(request('/api/planning-roles', { cookie }))
  const api = setup()
  const ok = await read(await listRoles(api, await plannerCookie(api)))
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json.roles, [{ id: 3, name: 'Monteur' }, { id: 4, name: 'Planner' }])
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.equal((await read(await listRoles(api, await monteurCookie(api)))).status, 403)
  assert.equal((await read(await listRoles(api, undefined))).status, 401)
  assert.equal(api.odoo.roleCalls, 1, 'the gateway was asked for the admin only')

  api.odoo.roles = () => ({ ok: false, message: 'De planningsrollen konden niet uit Odoo worden gelezen. Probeer het zo opnieuw.' })
  const failed = await read(await listRoles(api, await plannerCookie(api)))
  assert.equal(failed.status, 502)
  assert.match(failed.json.error, /planningsrollen konden niet/)

  const off = setup({ mode: 'off' })
  assert.equal((await read(await listRoles(off, undefined))).status, 404)
  assert.equal(off.odoo.roleCalls, 0)
})

// ---------------------------------------------------------------- planning roles of an existing technician

const rolesGet = (api: Api, cookie: string | undefined, id: string) => api.handlers.accountRolesGet(request(`/api/accounts/${id}/planning-roles`, { cookie }), id)
const rolesSet = (api: Api, cookie: string | undefined, id: string, body: unknown, init: { csrf?: boolean } = {}) =>
  api.handlers.accountRolesSet(request(`/api/accounts/${id}/planning-roles`, { method: 'PUT', cookie, body, csrf: init.csrf }), id)
const accountId = (api: Api, username: string) => api.accounts.list().find((account) => account.username === username)?.id as string

test('planning roles of a technician: an admin reads what Odoo has now, for the Odoo employee behind the account', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const answer = await read(await rolesGet(api, cookie, accountId(api, 'jan')))
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json, { employeeId: 7, planningRoleIds: [3, 4], defaultPlanningRoleId: 3 })
  assert.deepEqual(api.odoo.reads, [7], 'the employee comes from the account, not from the browser')
  assert.equal(answer.headers.get('cache-control'), 'no-store')
})

test('planning roles of a technician: the admin sets them, and only the roles can be sent', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const answer = await read(await rolesSet(api, cookie, accountId(api, 'jan'), { planningRoleIds: [4, 3] }))
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json, { employeeId: 7, planningRoles: 2, asked: 2 })
  assert.deepEqual(api.odoo.sets, [{ employeeId: 7, planningRoleIds: [4, 3] }])
  assert.equal((await read(await rolesSet(api, cookie, accountId(api, 'jan'), { planningRoleIds: [] }))).status, 200, 'no roles: takes them away')
  assert.deepEqual(api.odoo.sets.at(-1), { employeeId: 7, planningRoleIds: [] })
  const before = api.odoo.sets.length
  for (const extra of [{ employeeId: 99 }, { employee_id: 99 }, { name: 'Anders' }, { personId: 'employee:99' }, { user_id: 5 }, { defaultPlanningRoleId: 3 }, { vals: { active: false } }]) {
    const refused = await read(await rolesSet(api, cookie, accountId(api, 'jan'), { planningRoleIds: [3], ...extra }))
    assert.equal(refused.status, 400, JSON.stringify(extra))
    assert.match(refused.json.error, /Onbekend veld/)
  }
  assert.equal(api.odoo.sets.length, before, 'nothing was sent to the gateway')
})

test('planning roles of a technician: the answer says how many roles Odoo confirmed, not how many were asked', async () => {
  const api = setup()
  api.odoo.setRolesAnswer = () => ({ ok: true, planningRoles: 1, asked: 2 })
  const answer = await read(await rolesSet(api, await plannerCookie(api), accountId(api, 'jan'), { planningRoleIds: [3, 4] }))
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json, { employeeId: 7, planningRoles: 1, asked: 2 })
})

test('planning roles of a technician: odd roles are a clear error and never reach the gateway', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  for (const planningRoleIds of [undefined, '3', 3, null, {}, [0], [-1], [1.5], ['3'], [3, 3], [1, 2, 3, 4, 5, 6], [null]]) {
    const answer = await read(await rolesSet(api, cookie, accountId(api, 'jan'), planningRoleIds === undefined ? {} : { planningRoleIds }))
    assert.equal(answer.status, 400, JSON.stringify(planningRoleIds))
    assert.match(answer.json.error, /planningsrollen/)
  }
  assert.equal(api.odoo.sets.length, 0)
})

test('planning roles of a technician: only an admin, with the header, for an account that is a technician linked to an Odoo employee', async () => {
  const api = setup()
  const id = accountId(api, 'jan')
  assert.equal((await read(await rolesGet(api, undefined, id))).status, 401)
  assert.equal((await read(await rolesSet(api, undefined, id, { planningRoleIds: [3] }))).status, 401)
  const monteur = await monteurCookie(api)
  assert.equal((await read(await rolesGet(api, monteur, id))).status, 403, 'a technician cannot read his own roles here')
  assert.equal((await read(await rolesSet(api, monteur, id, { planningRoleIds: [3] }))).status, 403)
  const planner = await plannerCookie(api)
  assert.equal((await read(await rolesSet(api, planner, id, { planningRoleIds: [3] }, { csrf: false }))).status, 403, 'a change needs the header')
  assert.equal((await read(await rolesGet(api, planner, 'u_bestaat_niet'))).status, 404)
  assert.equal((await read(await rolesSet(api, planner, 'u_bestaat_niet', { planningRoleIds: [3] }))).status, 404)
  // An admin account, and a technician linked only by name (not an Odoo employee), have no roles to change.
  assert.equal((await read(await rolesGet(api, planner, accountId(api, 'planner')))).status, 400)
  api.accounts.create({ username: 'naam', name: 'Piet', role: 'monteur', personId: 'name:piet', password: PASSWORD })
  api.accounts.create({ username: 'gebruiker', name: 'Els', role: 'monteur', personId: 'user:5', password: PASSWORD })
  // A number too long for an Odoo id is not cut off into another employee's number.
  api.accounts.create({ username: 'te.lang', name: 'Lang', role: 'monteur', personId: 'employee:12345678901', password: PASSWORD })
  // Even an admin account that happens to carry an employee in its person field is not a technician.
  api.accounts.create({ username: 'beheer.met.medewerker', name: 'Beheerder', role: 'admin', personId: 'employee:9', password: PASSWORD })
  for (const username of ['naam', 'gebruiker', 'te.lang', 'beheer.met.medewerker']) {
    assert.equal((await read(await rolesGet(api, planner, accountId(api, username)))).status, 400, username)
    assert.equal((await read(await rolesSet(api, planner, accountId(api, username), { planningRoleIds: [3] }))).status, 400, username)
  }
  assert.equal(api.odoo.reads.length, 0)
  assert.equal(api.odoo.sets.length, 0)
})

test('planning roles of a technician: with logins off there is none of this', async () => {
  const api = setup({ mode: 'off' })
  assert.equal((await read(await rolesGet(api, undefined, 'u_x'))).status, 404)
  assert.equal((await read(await rolesSet(api, undefined, 'u_x', { planningRoleIds: [3] }))).status, 404)
  assert.equal(api.odoo.reads.length + api.odoo.sets.length, 0)
})

test('planning roles of a technician: a problem of the gateway or Odoo is a clear error, a missing employee is a 404', async () => {
  const api = setup()
  const cookie = await plannerCookie(api)
  const id = accountId(api, 'jan')
  api.odoo.employeeRoles = () => ({ ok: false, message: 'De planningsrollen van deze medewerker konden niet uit Odoo worden gelezen. Probeer het zo opnieuw.' })
  const failed = await read(await rolesGet(api, cookie, id))
  assert.equal(failed.status, 502)
  assert.match(failed.json.error, /konden niet/)
  api.odoo.employeeRoles = () => ({ ok: false, notFound: true, message: 'Deze medewerker bestaat niet (meer) in Odoo, of is gearchiveerd.' })
  assert.equal((await read(await rolesGet(api, cookie, id))).status, 404)
  api.odoo.setRolesAnswer = () => ({ ok: false, message: 'Een gekozen planningsrol bestaat niet (meer) in Odoo, is gearchiveerd of is niet toegestaan. Er is niets gewijzigd.' })
  const refused = await read(await rolesSet(api, cookie, id, { planningRoleIds: [3] }))
  assert.equal(refused.status, 502)
  assert.match(refused.json.error, /niets gewijzigd/)
  api.odoo.setRolesAnswer = () => ({ ok: false, notFound: true, message: 'Deze medewerker bestaat niet (meer) in Odoo, of is gearchiveerd. Er is niets gewijzigd.' })
  assert.equal((await read(await rolesSet(api, cookie, id, { planningRoleIds: [3] }))).status, 404)
})
