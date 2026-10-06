import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountStore } from '../src/lib/accounts.ts'
import type { AccountIo } from '../src/lib/accounts.ts'
import { createAuth, EMERGENCY_ID } from '../src/lib/auth.ts'
import { hashPassword } from '../src/lib/password.ts'
import { createLoginLimiter, createSessions } from '../src/lib/sessions.ts'

const SECRET = 'a-secret-of-at-least-thirty-two-bytes!'
const PASSWORD = 'een-goed-wachtwoord'
const EMERGENCY_PASSWORD = 'noodwachtwoord-van-de-server'
const EMERGENCY_HASH = hashPassword(EMERGENCY_PASSWORD)

function setup(options: { emergency?: boolean; maxFailures?: number } = {}) {
  const state = { text: null as string | null }
  const io: AccountIo = { read: () => state.text, write: (text) => (state.text = text) }
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const accounts = createAccountStore({ io, reservedUsernames: ['noodadmin'] })
  const auth = createAuth({
    accounts,
    sessions: createSessions({ secret: SECRET, now: clock.now }),
    limiter: createLoginLimiter({ max: options.maxFailures ?? 5, now: clock.now }),
    emergency: options.emergency === false ? null : { username: 'noodadmin', passwordHash: EMERGENCY_HASH },
  })
  const jan = accounts.create({ username: 'jan', name: 'Jan de Vries', role: 'monteur', personId: 'employee:7', password: PASSWORD })
  return { auth, accounts, state, clock, jan }
}

const login = (auth: ReturnType<typeof setup>['auth'], username: unknown, password: unknown, client = '10.0.0.1') =>
  auth.login({ username, password, client })

function assertOk(result: ReturnType<ReturnType<typeof setup>['auth']['login']>) {
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  return result
}

test('a right user name and password give the user, a token and the lifetime of the cookie', () => {
  const { auth, jan } = setup()
  const result = assertOk(login(auth, 'jan', PASSWORD))
  assert.deepEqual(result.user, { id: jan.id, username: 'jan', name: 'Jan de Vries', role: 'monteur', personId: 'employee:7', emergency: false })
  assert.equal(result.maxAgeSeconds, 12 * 60 * 60)
  assert.deepEqual(auth.userFromToken(result.token), result.user)
})

test('wrong password, unknown user and disabled account all get the same answer', () => {
  const { auth, accounts, jan } = setup()
  accounts.create({ username: 'els', name: 'Els', role: 'monteur', personId: 'employee:8', password: PASSWORD })
  accounts.update(accounts.list().find((a) => a.username === 'els')!.id, { disabled: true })
  const answers = [
    login(auth, 'jan', 'verkeerd-wachtwoord'),
    login(auth, 'niemand', PASSWORD),
    login(auth, 'els', PASSWORD),
  ]
  for (const answer of answers) assert.deepEqual(answer, { ok: false, status: 401, message: 'Onjuiste gebruikersnaam of wachtwoord.' })
  assert.ok(jan)
})

test('missing or odd input is refused without looking at the accounts', () => {
  const { auth } = setup()
  for (const [username, password] of [['', ''], ['jan', ''], ['', PASSWORD], [undefined, PASSWORD], ['jan', undefined], [123, PASSWORD], ['jan', { $ne: 1 }], [['jan'], PASSWORD]]) {
    const result = login(auth, username, password)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 400, `${String(username)} / ${String(password)}`)
  }
  assert.equal((login(auth, 'x'.repeat(500), PASSWORD) as { status: number }).status, 400)
  assert.equal((login(auth, 'jan', 'x'.repeat(5000)) as { status: number }).status, 400)
})

test('a client that tries too many names is refused, even with a right password, and other clients are not affected', () => {
  const { auth } = setup({ maxFailures: 3 })
  for (const name of ['piet', 'klaas', 'marie']) assert.equal((login(auth, name, 'fout-wachtwoord-1', '10.0.0.9') as { status: number }).status, 401)
  const blocked = login(auth, 'jan', PASSWORD, '10.0.0.9')
  assert.deepEqual(blocked, { ok: false, status: 429, message: 'Te veel pogingen. Probeer het later opnieuw.' })
  assert.equal(login(auth, 'jan', PASSWORD, '10.0.0.2').ok, true, 'another client is not affected')
})

test('after too many wrong attempts on one account, it is refused from any client', () => {
  const { auth } = setup({ maxFailures: 3 })
  for (let i = 0; i < 3; i++) login(auth, 'jan', 'fout-wachtwoord-1', `10.0.0.${i + 10}`)
  assert.equal((login(auth, 'jan', PASSWORD, '10.0.0.99') as { status: number }).status, 429)
  assert.equal(login(auth, 'sanne-bestaat-niet', PASSWORD, '10.0.0.99').ok, false)
})

test('the block lifts after the window, and a login that works clears the failures of that account', () => {
  const { auth, clock } = setup({ maxFailures: 3 })
  for (let i = 0; i < 3; i++) login(auth, 'jan', 'fout-wachtwoord-1', '10.0.0.9')
  assert.equal((login(auth, 'jan', PASSWORD, '10.0.0.9') as { status: number }).status, 429)
  clock.advance(15 * 60_000)
  assertOk(login(auth, 'jan', PASSWORD, '10.0.0.9'))
  login(auth, 'jan', 'fout-wachtwoord-1', '10.0.0.5')
  login(auth, 'jan', 'fout-wachtwoord-1', '10.0.0.6')
  assertOk(login(auth, 'jan', PASSWORD, '10.0.0.7'))
  login(auth, 'jan', 'fout-wachtwoord-1', '10.0.0.8')
  login(auth, 'jan', 'fout-wachtwoord-1', '10.0.0.8')
  assert.equal(login(auth, 'jan', PASSWORD, '10.0.0.4').ok, true, 'the earlier failures were cleared by the login that worked')
})

test('a login that works does not clear the failures of the client: a valid account cannot be used to reset the count', () => {
  const { auth } = setup({ maxFailures: 3 })
  login(auth, 'jan', 'fout-wachtwoord-1', '10.0.0.9')
  login(auth, 'jan', 'fout-wachtwoord-1', '10.0.0.9')
  assertOk(login(auth, 'jan', PASSWORD, '10.0.0.9'))
  login(auth, 'niemand', 'fout-wachtwoord-1', '10.0.0.9')
  assert.equal((login(auth, 'jan', PASSWORD, '10.0.0.9') as { status: number }).status, 429)
})

test('the emergency admin logs in with the password from the server settings', () => {
  const { auth } = setup()
  const result = assertOk(login(auth, ' NoodAdmin ', EMERGENCY_PASSWORD))
  assert.deepEqual(result.user, { id: EMERGENCY_ID, username: 'noodadmin', name: 'Noodadmin', role: 'admin', personId: null, emergency: true })
  assert.deepEqual(auth.userFromToken(result.token), result.user)
  assert.equal(login(auth, 'noodadmin', PASSWORD).ok, false)
  assert.equal(login(auth, 'noodadmin', 'verkeerd-wachtwoord-x').ok, false)
})

test('without an emergency admin in the settings there is none, and its token is worthless', () => {
  const withEmergency = setup()
  const token = assertOk(login(withEmergency.auth, 'noodadmin', EMERGENCY_PASSWORD)).token
  const without = setup({ emergency: false })
  assert.equal(login(without.auth, 'noodadmin', EMERGENCY_PASSWORD).ok, false)
  assert.equal(without.auth.userFromToken(token), null)
})

test('the emergency admin still gets in when the account file is damaged, and others get an error, not access', () => {
  const { auth, state } = setup()
  const token = assertOk(login(auth, 'noodadmin', EMERGENCY_PASSWORD)).token
  state.text = '{ kapot'
  assert.equal(auth.userFromToken(token)?.emergency, true)
  assertOk(login(auth, 'noodadmin', EMERGENCY_PASSWORD, '10.0.0.3'))
  assert.throws(() => login(auth, 'jan', PASSWORD))
})

test('a token only counts while the account is there, enabled and unchanged', () => {
  const { auth, accounts, jan } = setup()
  const token = () => assertOk(login(auth, 'jan', PASSWORD, `10.0.${Math.random()}`)).token
  let t = token()
  assert.ok(auth.userFromToken(t))
  accounts.update(jan.id, { name: 'Jan V.' })
  assert.equal(auth.userFromToken(t)?.name, 'Jan V.', 'a new display name keeps the session')
  accounts.update(jan.id, { disabled: true })
  assert.equal(auth.userFromToken(t), null, 'disabled')
  accounts.update(jan.id, { disabled: false })
  assert.equal(auth.userFromToken(t), null, 'enabling again does not bring the old session back')
  t = token()
  accounts.update(jan.id, { personId: 'employee:9' })
  assert.equal(auth.userFromToken(t), null, 'another person')
  t = token()
  accounts.resetPassword(jan.id, 'een-ander-wachtwoord')
  assert.equal(auth.userFromToken(t), null, 'new password')
  t = assertOk(login(auth, 'jan', 'een-ander-wachtwoord')).token
  accounts.remove(jan.id)
  assert.equal(auth.userFromToken(t), null, 'removed')
})

test('a token that expired, or is not a token, gives nobody', () => {
  const { auth, clock } = setup()
  const token = assertOk(login(auth, 'jan', PASSWORD)).token
  for (const bad of [undefined, '', 'x', token + 'x', token.slice(1)]) assert.equal(auth.userFromToken(bad), null)
  clock.advance(12 * 60 * 60_000)
  assert.equal(auth.userFromToken(token), null)
})

test('changing your own password needs the current one and gives a new session, the old one ends', () => {
  const { auth } = setup()
  const first = assertOk(login(auth, 'jan', PASSWORD))
  const refused = auth.changePassword(first.user, 'verkeerd-wachtwoord', 'een-ander-wachtwoord')
  assert.deepEqual(refused, { ok: false, status: 400, message: 'Het huidige wachtwoord klopt niet.' })
  assert.ok(auth.userFromToken(first.token))
  const changed = auth.changePassword(first.user, PASSWORD, 'een-ander-wachtwoord')
  assert.equal(changed.ok, true)
  if (!changed.ok) return
  assert.equal(auth.userFromToken(first.token), null, 'the old session ended')
  assert.equal(auth.userFromToken(changed.token)?.id, first.user.id, 'the new one works')
  assert.equal(login(auth, 'jan', PASSWORD).ok, false)
  assertOk(login(auth, 'jan', 'een-ander-wachtwoord'))
})

test('the current password cannot be guessed through "change password" either', () => {
  const { auth } = setup({ maxFailures: 3 })
  const session = assertOk(login(auth, 'jan', PASSWORD))
  for (let i = 0; i < 3; i++) {
    assert.equal((auth.changePassword(session.user, 'verkeerd-wachtwoord', 'een-ander-wachtwoord') as { status: number }).status, 400)
  }
  const blocked = auth.changePassword(session.user, PASSWORD, 'een-ander-wachtwoord')
  assert.deepEqual(blocked, { ok: false, status: 429, message: 'Te veel pogingen. Probeer het later opnieuw.' })
  assert.ok(auth.userFromToken(session.token), 'nothing was changed')
  assert.equal(login(auth, 'jan', PASSWORD, '10.0.0.77').ok, false, 'the account is blocked for logging in as well, from any client')
})

test('a too short new password is refused with the reason', () => {
  const { auth } = setup()
  const first = assertOk(login(auth, 'jan', PASSWORD))
  const result = auth.changePassword(first.user, PASSWORD, 'kort')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /minstens 12/)
  assert.ok(auth.userFromToken(first.token), 'the session stays')
})

test('the emergency admin cannot change the password here: it lives in the server settings', () => {
  const { auth } = setup()
  const result = assertOk(login(auth, 'noodadmin', EMERGENCY_PASSWORD))
  const changed = auth.changePassword(result.user, EMERGENCY_PASSWORD, 'een-ander-wachtwoord')
  assert.equal(changed.ok, false)
  if (!changed.ok) {
    assert.equal(changed.status, 403)
    assert.match(changed.message, /serverinstellingen/)
  }
})
