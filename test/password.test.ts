import test from 'node:test'
import assert from 'node:assert/strict'
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from '../src/lib/password.ts'

// Made by the hash tool of the preview proxy (`bun run preview:password`) with a fixed salt: the same format.
const PROXY_HASH =
  'scrypt:000102030405060708090a0b0c0d0e0f:a325751baaa3cdf478ecc39768962a253dbd723beab5eaf620a0c293ebd66614'

test('a password verifies against its own hash, and only that password does', () => {
  const stored = hashPassword('een-goed-wachtwoord')
  assert.equal(verifyPassword('een-goed-wachtwoord', stored), true)
  assert.equal(verifyPassword('een-goed-wachtwoord ', stored), false)
  assert.equal(verifyPassword('Een-goed-wachtwoord', stored), false)
  assert.equal(verifyPassword('', stored), false)
})

test('the same password gets a different hash every time (random salt)', () => {
  assert.notEqual(hashPassword('een-goed-wachtwoord'), hashPassword('een-goed-wachtwoord'))
})

test('the hash has the format of the preview proxy, so its tool can make the emergency admin hash', () => {
  assert.match(hashPassword('x'.repeat(12)), /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/)
  assert.equal(verifyPassword('een-wachtwoord-van-12+', PROXY_HASH), true)
  assert.equal(verifyPassword('een-wachtwoord-van-12-', PROXY_HASH), false)
})

test('a stored value that is not a valid hash never verifies, and never throws', () => {
  for (const stored of ['', 'x', 'scrypt:', 'scrypt:zz:zz', 'bcrypt:aa:bb', 'scrypt:00:', 'scrypt::00', 'scrypt:00:00:00']) {
    assert.equal(verifyPassword('een-goed-wachtwoord', stored), false, stored)
  }
  assert.equal(verifyPassword('een-goed-wachtwoord', undefined), false)
  assert.equal(verifyPassword('een-goed-wachtwoord', null), false)
})

test('a password must be 12 to 200 characters, and says why when it is not', () => {
  assert.equal(passwordProblem('a'.repeat(12)), null)
  assert.equal(passwordProblem('a'.repeat(200)), null)
  assert.match(passwordProblem('a'.repeat(11)) ?? '', /minstens 12/)
  assert.match(passwordProblem('') ?? '', /minstens 12/)
  assert.match(passwordProblem('a'.repeat(201)) ?? '', /hoogstens 200/)
  assert.match(passwordProblem(123 as unknown as string) ?? '', /minstens 12/)
})

test('a generated password is long enough, readable and different every time', () => {
  const first = generatePassword()
  assert.equal(passwordProblem(first), null)
  assert.match(first, /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/, 'no look-alike characters (0, O, 1, l, I)')
  const many = new Set(Array.from({ length: 50 }, () => generatePassword()))
  assert.equal(many.size, 50)
})
