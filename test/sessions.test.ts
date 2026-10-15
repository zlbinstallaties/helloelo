import test from 'node:test'
import assert from 'node:assert/strict'
import { clearSessionCookie, createLoginLimiter, createSessions, readCookie, sessionCookie } from '../src/lib/sessions.ts'

const SECRET = 'a-secret-of-at-least-thirty-two-bytes!'

function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

test('a token gives back the account and the session version it was issued for', () => {
  const sessions = createSessions({ secret: SECRET })
  assert.deepEqual(sessions.verify(sessions.issue('u_abc123', 4)), { userId: 'u_abc123', version: 4 })
})

test('an account id with dots, colons or spaces survives the token', () => {
  const sessions = createSessions({ secret: SECRET })
  for (const id of ['env:admin', 'a.b.c', 'met spatie', 'ünï.cødé']) {
    assert.deepEqual(sessions.verify(sessions.issue(id, 0)), { userId: id, version: 0 })
  }
})

test('every issued token is different, even for the same account', () => {
  const sessions = createSessions({ secret: SECRET })
  assert.notEqual(sessions.issue('u_1', 0), sessions.issue('u_1', 0))
})

test('a token is valid until its lifetime has passed, and not a moment longer', () => {
  const time = clock()
  const sessions = createSessions({ secret: SECRET, ttlMs: 60_000, now: time.now })
  const token = sessions.issue('u_1', 0)
  time.advance(59_999)
  assert.ok(sessions.verify(token))
  time.advance(1)
  assert.equal(sessions.verify(token), null)
})

test('the default lifetime is 12 hours', () => {
  const time = clock()
  const sessions = createSessions({ secret: SECRET, now: time.now })
  assert.equal(sessions.ttlMs, 12 * 60 * 60_000)
  const token = sessions.issue('u_1', 0)
  time.advance(12 * 60 * 60_000 - 1)
  assert.ok(sessions.verify(token))
  time.advance(1)
  assert.equal(sessions.verify(token), null)
})

test('a token that was changed in any part is rejected', () => {
  const sessions = createSessions({ secret: SECRET })
  const parts = sessions.issue('u_1', 0).split('.')
  assert.equal(parts.length, 5)
  const swap = (index: number, value: string) => parts.map((part, i) => (i === index ? value : part)).join('.')
  assert.equal(sessions.verify(swap(0, Buffer.from('u_2').toString('base64url'))), null, 'other account')
  assert.equal(sessions.verify(swap(1, String(Date.now() + 10 ** 12))), null, 'longer lifetime')
  assert.equal(sessions.verify(swap(2, '9')), null, 'other version')
  assert.equal(sessions.verify(swap(3, 'AAAAAAAAAAAA')), null, 'other nonce')
  assert.equal(sessions.verify(swap(4, parts[4].slice(0, -1) + (parts[4].endsWith('A') ? 'B' : 'A'))), null, 'signature')
})

test('a token made with another secret is rejected', () => {
  const other = createSessions({ secret: 'another-secret-of-at-least-32-bytes!!' })
  assert.equal(createSessions({ secret: SECRET }).verify(other.issue('u_1', 0)), null)
})

test('anything that is not a token is rejected and never throws', () => {
  const sessions = createSessions({ secret: SECRET })
  for (const value of [undefined, '', 'x', 'a.b', 'a.b.c.d', 'a.b.c.d.e.f', '....', 'a.b.c.d.e', '%%.1.2.3.4']) {
    assert.equal(sessions.verify(value), null, String(value))
  }
})

test('a secret shorter than 32 bytes is refused', () => {
  assert.throws(() => createSessions({ secret: 'too-short' }), /32 bytes/)
})

test('the session cookie is HttpOnly, SameSite=Strict and for the whole site; Secure when asked', () => {
  const secure = sessionCookie('tok', { maxAgeSeconds: 3600, secure: true })
  assert.equal(secure, 'dig_dashboard=tok; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict; Secure')
  assert.equal(sessionCookie('tok', { maxAgeSeconds: 3600, secure: false }), 'dig_dashboard=tok; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict')
  assert.match(clearSessionCookie(true), /^dig_dashboard=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict; Secure$/)
})

test('the cookie is found among other cookies and not confused with a similar name', () => {
  assert.equal(readCookie('a=1; dig_dashboard=tok; b=2', 'dig_dashboard'), 'tok')
  assert.equal(readCookie('xdig_dashboard=nee; dig_dashboard_2=nee', 'dig_dashboard'), undefined)
  assert.equal(readCookie('dig_dashboard=a=b=c', 'dig_dashboard'), 'a=b=c')
  assert.equal(readCookie(undefined, 'dig_dashboard'), undefined)
  assert.equal(readCookie('', 'dig_dashboard'), undefined)
})

test('the login limiter blocks a key after too many failures, and lets it back in after the window', () => {
  const time = clock()
  const limiter = createLoginLimiter({ max: 3, windowMs: 60_000, now: time.now })
  for (let i = 0; i < 2; i++) limiter.fail('jan')
  assert.equal(limiter.blocked('jan'), false)
  limiter.fail('jan')
  assert.equal(limiter.blocked('jan'), true)
  assert.equal(limiter.blocked('sanne'), false, 'other keys are not affected')
  time.advance(60_000)
  assert.equal(limiter.blocked('jan'), false)
})

test('failures that are older than the window do not count', () => {
  const time = clock()
  const limiter = createLoginLimiter({ max: 2, windowMs: 60_000, now: time.now })
  limiter.fail('jan')
  time.advance(40_000)
  limiter.fail('jan')
  time.advance(30_000) // the first failure is 70 s old now
  assert.equal(limiter.blocked('jan'), false)
  limiter.fail('jan')
  assert.equal(limiter.blocked('jan'), true)
})

test('a successful login clears the failures of that key only', () => {
  const limiter = createLoginLimiter({ max: 2 })
  limiter.fail('jan')
  limiter.fail('jan')
  limiter.fail('sanne')
  limiter.reset('jan')
  assert.equal(limiter.blocked('jan'), false)
  limiter.fail('jan')
  assert.equal(limiter.blocked('jan'), false)
  assert.equal(limiter.blocked('sanne'), false)
})

test('the limiter does not keep every key it ever saw', () => {
  const time = clock()
  const limiter = createLoginLimiter({ max: 3, windowMs: 1000, now: time.now, maxKeys: 100 })
  for (let i = 0; i < 1000; i++) limiter.fail(`client-${i}`)
  assert.ok(limiter.size() <= 100, `size ${limiter.size()}`)
  time.advance(2000)
  limiter.fail('nieuw')
  assert.ok(limiter.size() <= 100)
})
