import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayError } from '../src/lib/gateway-error.ts'
import { EMERGENCY_PASSWORD, ODOO, PASSWORD, dashboard, ids, login, read, request, setup } from './api-helpers.ts'

test('the server is not set up for logins: everything is refused, nothing is read, nothing is open', async () => {
  const api = setup({ configured: false })
  for (const call of [
    () => api.handlers.dashboardGet(request('/api/dashboard')),
    () => api.handlers.dashboardRefresh(request('/api/dashboard', { method: 'POST' })),
    () => api.handlers.login(request('/api/auth/login', { method: 'POST', body: { username: 'jan', password: PASSWORD } })),
    () => api.handlers.me(request('/api/auth/me')),
  ]) {
    const response = await read(await call())
    assert.equal(response.status, 503)
    assert.match(response.json.error, /niet ingesteld/)
  }
  assert.deepEqual(api.loads, [])
})

test('with logins switched off the dashboard works as before: open, with refresh, no login', async () => {
  const api = setup({ mode: 'off' })
  const read1 = await dashboard(api, undefined, '?scope=all&date=2026-10-05')
  assert.equal(read1.status, 200)
  assert.equal(read1.json.appointments.length, 5)
  assert.ok(read1.json.appointments.some((a: { odooUrl: string | null }) => a.odooUrl?.startsWith(ODOO)))
  assert.deepEqual(read1.json.technicians.map((t: { value: string }) => t.value), ['employee:7', 'employee:8'])
  const refreshed = await read(await api.handlers.dashboardRefresh(request('/api/dashboard', { method: 'POST' })))
  assert.equal(refreshed.status, 200)
  assert.deepEqual(api.loads, [false, true])
  const me = await read(await api.handlers.me(request('/api/auth/me')))
  assert.deepEqual(me.json, { authMode: 'off', user: null, canRefresh: true, canManageAccounts: false, canCreateEmployees: false })
  assert.equal((await read(await api.handlers.login(request('/api/auth/login', { method: 'POST', body: { username: 'jan', password: PASSWORD } })))).status, 404)
})

test('not logged in: 401, and the data is not even read', async () => {
  const api = setup()
  for (const cookie of [undefined, 'dig_dashboard=', 'dig_dashboard=rommel', 'andere=1']) {
    assert.equal((await dashboard(api, cookie)).status, 401, String(cookie))
  }
  assert.equal((await read(await api.handlers.dashboardRefresh(request('/api/dashboard', { method: 'POST' })))).status, 401)
  assert.deepEqual(api.loads, [])
})

test('a technician logs in and sees only the appointments of their person, without links to Odoo', async () => {
  const api = setup()
  const { response, cookie } = await login(api, 'jan')
  assert.equal(response.status, 200)
  assert.ok(cookie)
  const answer = await dashboard(api, cookie, '?scope=all&date=2026-10-05')
  assert.equal(answer.status, 200)
  assert.deepEqual(ids(answer.json.appointments), ['slot-1', 'slot-3'])
  assert.deepEqual(answer.json.technicians, [])
  assert.ok(!answer.text.includes(ODOO), 'the address of Odoo is nowhere in the answer')
  assert.equal(answer.headers.get('cache-control'), 'no-store')
})

test('a technician cannot see colleagues by asking for them: the technician parameter does nothing for them', async () => {
  const api = setup()
  const { cookie } = await login(api, 'jan')
  const answer = await dashboard(api, cookie, '?scope=all&date=2026-10-05&technician=employee:8')
  assert.deepEqual(ids(answer.json.appointments), ['slot-1', 'slot-3'])
})

test('the filters still work for a technician: period and date', async () => {
  const api = setup()
  const { cookie } = await login(api, 'jan')
  assert.deepEqual(ids((await dashboard(api, cookie, '?scope=day&date=2026-10-05')).json.appointments), ['slot-1', 'slot-3'])
  assert.deepEqual(ids((await dashboard(api, cookie, '?scope=day&date=2026-10-06')).json.appointments), [])
  assert.deepEqual(ids((await dashboard(api, cookie, '?scope=upcoming&date=2026-10-06')).json.appointments), [])
})

test('a planner (admin) sees everything with the links to Odoo, and can filter by technician', async () => {
  const api = setup()
  const { cookie } = await login(api, 'planner')
  const all = await dashboard(api, cookie, '?scope=all&date=2026-10-05')
  assert.equal(all.json.appointments.length, 5)
  assert.ok(all.text.includes(ODOO))
  assert.deepEqual(all.json.technicians.map((t: { value: string }) => t.value), ['employee:7', 'employee:8'])
  const jan = await dashboard(api, cookie, '?scope=all&date=2026-10-05&technician=employee:7')
  assert.deepEqual(ids(jan.json.appointments), ['slot-1', 'slot-3'])
})

test('the existing answer is unchanged: date, scope, loadedAt, company and the truncated flag', async () => {
  const api = setup()
  const { cookie } = await login(api, 'planner')
  const answer = await dashboard(api, cookie, '?scope=bogus&date=geen-datum')
  assert.equal(answer.json.scope, 'day')
  assert.match(answer.json.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(answer.json.company, { id: 2, name: 'Test BV' })
  assert.equal(answer.json.loadedAt, '2026-10-05T00:00:00.000Z')
  assert.equal(answer.json.truncated, false)
})

test('only an admin may refresh from Odoo', async () => {
  const api = setup()
  const jan = (await login(api, 'jan')).cookie
  const planner = (await login(api, 'planner')).cookie
  const refused = await read(await api.handlers.dashboardRefresh(request('/api/dashboard', { method: 'POST', cookie: jan })))
  assert.equal(refused.status, 403)
  assert.deepEqual(api.loads, [])
  const done = await read(await api.handlers.dashboardRefresh(request('/api/dashboard?scope=all&date=2026-10-05', { method: 'POST', cookie: planner })))
  assert.equal(done.status, 200)
  assert.deepEqual(api.loads, [true])
  assert.equal(done.json.appointments.length, 5)
})

test('a request that changes something needs the header of the dashboard, also with a valid session', async () => {
  const api = setup()
  const { cookie } = await login(api, 'planner')
  const refresh = await read(await api.handlers.dashboardRefresh(request('/api/dashboard', { method: 'POST', cookie, csrf: false })))
  assert.equal(refresh.status, 403)
  assert.deepEqual(api.loads, [])
  const loginWithoutHeader = await read(await api.handlers.login(request('/api/auth/login', { method: 'POST', body: { username: 'jan', password: PASSWORD }, csrf: false })))
  assert.equal(loginWithoutHeader.status, 403)
  const logout = await read(await api.handlers.logout(request('/api/auth/logout', { method: 'POST', cookie, csrf: false })))
  assert.equal(logout.status, 403)
  const password = await read(await api.handlers.changePassword(request('/api/auth/password', { method: 'POST', cookie, csrf: false, body: { current: PASSWORD, next: 'een-ander-wachtwoord' } })))
  assert.equal(password.status, 403)
})

test('login: the cookie is HttpOnly, SameSite=Strict, Secure and lasts as long as the session', async () => {
  const api = setup()
  const { response } = await login(api, 'jan')
  const cookie = response.headers.get('set-cookie') ?? ''
  assert.match(cookie, /^dig_dashboard=[^;]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict; Secure$/)
  const body = await read(response)
  assert.deepEqual(body.json.user, { id: body.json.user.id, username: 'jan', name: 'Jan de Vries', role: 'monteur', personId: 'employee:7', emergency: false })
  assert.ok(!body.text.includes('scrypt'), 'no hash in an answer')
  const plain = setup({ secure: false })
  assert.ok(!((await login(plain, 'jan')).response.headers.get('set-cookie') ?? '').includes('Secure'))
})

test('login: wrong password or unknown user gives the same answer and no cookie', async () => {
  const api = setup()
  const wrong = await login(api, 'jan', 'verkeerd-wachtwoord')
  const unknown = await login(api, 'niemand')
  for (const answer of [wrong, unknown]) {
    assert.equal(answer.response.status, 401)
    assert.equal(answer.response.headers.get('set-cookie'), null)
    assert.equal((await read(answer.response.clone())).json.error, 'Onjuiste gebruikersnaam of wachtwoord.')
  }
})

test('login: odd input is a clear error, not a crash', async () => {
  const api = setup()
  for (const body of ['{ kapot', '[]', '"tekst"', 'null', '']) {
    const response = await read(await api.handlers.login(request('/api/auth/login', { method: 'POST', body })))
    assert.equal(response.status, 400, body)
    assert.ok(response.json.error)
  }
  const missing = await read(await api.handlers.login(request('/api/auth/login', { method: 'POST', body: { username: 'jan' } })))
  assert.equal(missing.status, 400)
  const big = await read(await api.handlers.login(request('/api/auth/login', { method: 'POST', body: { username: 'jan', password: 'x'.repeat(40_000) } })))
  assert.equal(big.status, 413)
  const wrongType = await read(await api.handlers.login(new Request('http://dash.test/api/auth/login', { method: 'POST', headers: { 'x-dig-dashboard': '1', 'content-type': 'text/plain' }, body: '{}' })))
  assert.equal(wrongType.status, 415)
})

test('login: too many wrong attempts from one address are blocked, with the address the server sees', async () => {
  const api = setup()
  for (const name of ['a1x', 'b2x', 'c3x', 'd4x']) assert.equal((await login(api, name, 'fout-wachtwoord-1', '10.9.9.9')).response.status, 401)
  assert.equal((await login(api, 'jan', PASSWORD, '10.9.9.9')).response.status, 429)
  assert.equal((await login(api, 'jan', PASSWORD, '10.1.1.1')).response.status, 200)
})

test('logout clears the cookie', async () => {
  const api = setup()
  const { cookie } = await login(api, 'jan')
  const response = await api.handlers.logout(request('/api/auth/logout', { method: 'POST', cookie }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie') ?? '', /^dig_dashboard=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict; Secure$/)
})

test('me: who is logged in and what they may do', async () => {
  const api = setup()
  const anonymous = await read(await api.handlers.me(request('/api/auth/me')))
  assert.deepEqual(anonymous.json, { authMode: 'on', user: null, canRefresh: false, canManageAccounts: false, canCreateEmployees: false })
  const jan = (await login(api, 'jan')).cookie
  const asJan = await read(await api.handlers.me(request('/api/auth/me', { cookie: jan })))
  assert.equal(asJan.json.user.username, 'jan')
  assert.equal(asJan.json.canRefresh, false)
  assert.equal(asJan.json.canManageAccounts, false)
  assert.equal(asJan.json.canCreateEmployees, false)
  const planner = (await login(api, 'planner')).cookie
  const asPlanner = await read(await api.handlers.me(request('/api/auth/me', { cookie: planner })))
  assert.deepEqual([asPlanner.json.canRefresh, asPlanner.json.canManageAccounts, asPlanner.json.canCreateEmployees], [true, true, true])
})

test('a disabled account is out at once, an enabled one needs a new login', async () => {
  const api = setup()
  const { cookie } = await login(api, 'jan')
  assert.equal((await dashboard(api, cookie)).status, 200)
  api.accounts.update(api.accounts.list().find((a) => a.username === 'jan')!.id, { disabled: true })
  assert.equal((await dashboard(api, cookie)).status, 401)
  api.accounts.update(api.accounts.list().find((a) => a.username === 'jan')!.id, { disabled: false })
  assert.equal((await dashboard(api, cookie)).status, 401)
  assert.equal((await login(api, 'jan')).response.status, 200)
})

test('change your own password: needs the current one, gives a new session and ends the old one', async () => {
  const api = setup()
  const { cookie } = await login(api, 'jan')
  const wrong = await read(await api.handlers.changePassword(request('/api/auth/password', { method: 'POST', cookie, body: { current: 'verkeerd-wachtwoord', next: 'een-ander-wachtwoord' } })))
  assert.equal(wrong.status, 400)
  assert.equal((await dashboard(api, cookie)).status, 200)
  const changed = await api.handlers.changePassword(request('/api/auth/password', { method: 'POST', cookie, body: { current: PASSWORD, next: 'een-ander-wachtwoord' } }))
  assert.equal(changed.status, 200)
  const fresh = changed.headers.get('set-cookie')?.split(';')[0]
  assert.equal((await dashboard(api, cookie)).status, 401, 'the old session ended')
  assert.equal((await dashboard(api, fresh)).status, 200, 'the new one works')
  assert.equal((await login(api, 'jan', 'een-ander-wachtwoord')).response.status, 200)
  const nobody = await read(await api.handlers.changePassword(request('/api/auth/password', { method: 'POST', body: { current: PASSWORD, next: 'een-ander-wachtwoord' } })))
  assert.equal(nobody.status, 401)
})

test('an error from Odoo is passed on like before: 503 when the gateway is not set up, otherwise 502', async () => {
  const api = setup()
  const { cookie } = await login(api, 'planner')
  api.control.failWith = new GatewayError('Odoo-gateway is niet ingesteld.', 503, 'not_configured')
  const notSet = await dashboard(api, cookie)
  assert.equal(notSet.status, 503)
  assert.equal(notSet.json.error, 'Odoo-gateway is niet ingesteld.')
  api.control.failWith = new GatewayError('Odoo planning.slot kon niet worden gelezen (500).', 500)
  assert.equal((await dashboard(api, cookie)).status, 502)
  api.control.failWith = new Error('iets anders')
  const other = await dashboard(api, cookie)
  assert.equal(other.status, 502)
  assert.equal(other.json.error, 'iets anders')
  api.control.failWith = new GatewayError('Odoo-gateway is niet bereikbaar.', 502)
  const refresh = await read(await api.handlers.dashboardRefresh(request('/api/dashboard', { method: 'POST', cookie })))
  assert.equal(refresh.status, 502)
})

test('a damaged account file is an error for the accounts and not an opening; the emergency admin still gets in', async () => {
  const api = setup()
  const emergency = (await login(api, 'noodadmin', EMERGENCY_PASSWORD)).cookie
  const jan = (await login(api, 'jan')).cookie
  api.state.text = '{ kapot'
  const asJan = await dashboard(api, jan)
  assert.equal(asJan.status, 500)
  assert.match(asJan.json.error, /accountbestand/)
  assert.equal((await dashboard(api, emergency)).status, 200)
  assert.equal((await login(api, 'noodadmin', EMERGENCY_PASSWORD, '10.5.5.5')).response.status, 200)
  assert.equal((await login(api, 'jan', PASSWORD, '10.5.5.6')).response.status, 500)
})

test('no answer ever contains a password hash or a password', async () => {
  const api = setup()
  const seen: string[] = []
  const { response, cookie } = await login(api, 'planner')
  seen.push(await response.clone().text())
  seen.push((await dashboard(api, cookie, '?scope=all&date=2026-10-05')).text)
  seen.push(await (await api.handlers.me(request('/api/auth/me', { cookie }))).text())
  for (const text of seen) {
    assert.ok(!text.includes('scrypt'))
    assert.ok(!text.includes(PASSWORD))
  }
})
