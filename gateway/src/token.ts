import { randomBytes } from 'node:crypto'
import { sha256Hex } from './projects.ts'

/*
 * Generates a project token. Give the token to the app (as a server secret)
 * and put only the hash in the projects file.
 *
 *   node --experimental-strip-types gateway/src/token.ts
 */

const token = `dgw_${randomBytes(32).toString('base64url')}`
console.log(`token:       ${token}`)
console.log(`tokenSha256: ${sha256Hex(token)}`)
