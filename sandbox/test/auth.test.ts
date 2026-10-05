import test from 'node:test'
import assert from 'node:assert/strict'
import { createLoginLimiter, createSessions, hashPassword, parseCookies, stripSessionCookie, verifyPassword } from '../src/auth.ts'

const SECRET = 'x'.repeat(32)

test('password hashing', () => {
  const stored = hashPassword('correct horse battery')
  assert.match(stored, /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/)
  assert.equal(verifyPassword('correct horse battery', stored), true)
  assert.equal(verifyPassword('wrong', stored), false)
  assert.equal(verifyPassword('x', 'plain'), false)
  assert.notEqual(hashPassword('same'), hashPassword('same'))
})

test('sessions are signed and expire', () => {
  let now = 1_000_000
  const sessions = createSessions({ secret: SECRET, ttlMs: 1000, now: () => now })
  const token = sessions.issue()
  assert.equal(sessions.valid(token), true)
  const [exp, nonce, sig] = token.split('.')
  assert.equal(sessions.valid(`${Number(exp) + 99999}.${nonce}.${sig}`), false, 'extended expiry')
  assert.equal(sessions.valid(`${exp}.${nonce}.${sig.slice(0, -1)}A`), false, 'tampered signature')
  assert.equal(createSessions({ secret: 'y'.repeat(32), now: () => now }).valid(token), false, 'other secret')
  assert.equal(sessions.valid(undefined), false)
  now += 1001
  assert.equal(sessions.valid(token), false, 'expired')
  assert.throws(() => createSessions({ secret: 'short' }), /32 bytes/)
})

test('login limiter blocks after repeated failures and resets', () => {
  let now = 0
  const limiter = createLoginLimiter(3, 1000, () => now)
  for (let i = 0; i < 3; i++) limiter.fail('ip')
  assert.equal(limiter.blocked('ip'), true)
  assert.equal(limiter.blocked('other'), false)
  now = 1001
  assert.equal(limiter.blocked('ip'), false)
  limiter.fail('ip')
  limiter.reset('ip')
  assert.equal(limiter.blocked('ip'), false)
})

test('cookie helpers', () => {
  assert.equal(parseCookies('a=1; dig_preview=tok; b=2').get('dig_preview'), 'tok')
  assert.equal(stripSessionCookie('a=1; dig_preview=tok; b=2'), 'a=1; b=2')
  assert.equal(stripSessionCookie('dig_preview=tok'), undefined)
  assert.equal(stripSessionCookie(undefined), undefined)
})
