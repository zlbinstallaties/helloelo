import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-limits.ts'

/*
 * Passwords of the dashboard accounts. Only a scrypt hash is ever stored, in the same format as the preview
 * proxy (`scrypt:<salt hex>:<hash hex>`), so `bun run preview:password` can make the hash of the emergency admin.
 * No I/O, so it is unit-tested in test/.
 */

const KEY_LENGTH = 32
const SALT_LENGTH = 16
const STORED_FORMAT = /^scrypt:([0-9a-f]{32}):([0-9a-f]{64})$/

export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH }

export function hashPassword(password: string, salt: Buffer = randomBytes(SALT_LENGTH)): string {
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, KEY_LENGTH).toString('hex')}`
}

/** True when `stored` has the shape of a hash made by `hashPassword`. */
export function isPasswordHash(stored: unknown): stored is string {
  return typeof stored === 'string' && STORED_FORMAT.test(stored)
}

/** False for a wrong password and for anything that is not a valid stored hash; never throws on bad input. */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const match = STORED_FORMAT.exec(stored)
  if (!match) return false
  const expected = Buffer.from(match[2], 'hex')
  const actual = scryptSync(password, Buffer.from(match[1], 'hex'), KEY_LENGTH)
  return timingSafeEqual(actual, expected)
}

/** Why a password is not acceptable, or null when it is. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Het wachtwoord moet minstens ${MIN_PASSWORD_LENGTH} tekens hebben.`
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `Het wachtwoord mag hoogstens ${MAX_PASSWORD_LENGTH} tekens hebben.`
  return null
}

// No 0, O, 1, l or I: the password is read from a screen and typed on a phone.
const READABLE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** A random password like `aB3d-Ef6h-Jk8m-Np2q` (16 characters of 57 symbols, about 93 bits). */
export function generatePassword(): string {
  const group = () => Array.from({ length: 4 }, () => READABLE[randomInt(READABLE.length)]).join('')
  return [group(), group(), group(), group()].join('-')
}
