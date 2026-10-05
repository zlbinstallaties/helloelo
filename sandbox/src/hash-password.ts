import { randomBytes } from 'node:crypto'
import { hashPassword } from './auth.ts'

/*
 * Prints a password hash and a session secret for the preview proxy.
 *
 *   node --experimental-strip-types sandbox/src/hash-password.ts '<wachtwoord>'
 */

const password = process.argv[2]
if (!password || password.length < 12) {
  console.error('usage: hash-password.ts <password of at least 12 characters>')
  process.exit(1)
}
console.log(`PREVIEW_PASSWORD_HASH=${hashPassword(password)}`)
console.log(`PREVIEW_SESSION_SECRET=${randomBytes(32).toString('base64url')}`)
