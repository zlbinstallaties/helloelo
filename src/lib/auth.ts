import { AccountError, normalizeUsername } from './accounts.ts'
import type { AccountStore, PublicAccount } from './accounts.ts'
import type { User } from './authorization.ts'
import { MAX_PASSWORD_LENGTH, verifyPassword } from './password.ts'
import type { LoginLimiter, Sessions } from './sessions.ts'

/*
 * Logging in and recognising a logged-in person: ties the accounts, the signed sessions, the limit on wrong
 * attempts and the emergency admin from the server settings together. No I/O of its own (the account store
 * does that), so it is unit-tested in test/.
 */

export const EMERGENCY_ID = 'emergency'
const MAX_USERNAME_LENGTH = 64

export type EmergencyAdmin = { username: string; passwordHash: string }

export interface AuthOptions {
  accounts: AccountStore
  sessions: Sessions
  limiter: LoginLimiter
  /** The admin from the server settings; null when there is none. Works when the account file is damaged. */
  emergency?: EmergencyAdmin | null
}

type Failure = { ok: false; status: 400 | 401 | 403 | 429; message: string }
export type LoginResult = { ok: true; user: User; token: string; maxAgeSeconds: number } | Failure

const WRONG = { ok: false, status: 401, message: 'Onjuiste gebruikersnaam of wachtwoord.' } as const
const TOO_MANY = { ok: false, status: 429, message: 'Te veel pogingen. Probeer het later opnieuw.' } as const

function toUser(account: PublicAccount): User {
  return { id: account.id, username: account.username, name: account.name, role: account.role, personId: account.personId, emergency: false }
}

export function createAuth(options: AuthOptions) {
  const { accounts, sessions, limiter } = options
  const emergency = options.emergency ? { ...options.emergency, username: normalizeUsername(options.emergency.username) } : null
  const emergencyUser: User | null = emergency
    ? { id: EMERGENCY_ID, username: emergency.username, name: emergency.username.charAt(0).toUpperCase() + emergency.username.slice(1), role: 'admin', personId: null, emergency: true }
    : null

  const issue = (user: User, version: number) => ({ token: sessions.issue(user.id, version), maxAgeSeconds: Math.floor(sessions.ttlMs / 1000) })

  return {
    /**
     * Wrong attempts are counted per client address and per account name: a client cannot try all names, and a
     * name cannot be tried from many clients. A login that works clears the count of that name, not of the client,
     * so a valid account cannot be used to reset the count of an attacker.
     */
    login(input: { username: unknown; password: unknown; client: string }): LoginResult {
      const { username, password } = input
      if (
        typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password ||
        username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH
      ) {
        return { ok: false, status: 400, message: 'Vul je gebruikersnaam en wachtwoord in.' }
      }
      const name = normalizeUsername(username)
      const clientKey = `ip:${input.client}`
      const nameKey = `user:${name}`
      if (limiter.blocked(clientKey) || limiter.blocked(nameKey)) return TOO_MANY

      let user: User | null = null
      let version = 0
      if (emergency && emergencyUser && name === emergency.username) {
        if (verifyPassword(password, emergency.passwordHash)) user = emergencyUser
      } else {
        const account = accounts.authenticate(name, password)
        if (account) {
          user = toUser(account)
          version = accounts.sessionVersion(account.id) ?? 0
        }
      }
      if (!user) {
        limiter.fail(clientKey)
        limiter.fail(nameKey)
        return WRONG
      }
      limiter.reset(nameKey)
      return { ok: true, user, ...issue(user, version) }
    },

    /** The person a session token belongs to, or null when it is not (or no longer) valid. */
    userFromToken(token: string | undefined): User | null {
      const claim = sessions.verify(token)
      if (!claim) return null
      if (claim.userId === EMERGENCY_ID) return emergencyUser && claim.version === 0 ? emergencyUser : null
      const account = accounts.get(claim.userId)
      if (!account || account.disabled || accounts.sessionVersion(account.id) !== claim.version) return null
      return toUser(account)
    },

    /** Changes the password of the logged-in person; every other session of the account ends. */
    changePassword(user: User, current: string, next: string): ({ ok: true; user: User } & { token: string; maxAgeSeconds: number }) | Failure {
      if (user.emergency) {
        return { ok: false, status: 403, message: 'Het wachtwoord van het noodaccount wijzig je in de serverinstellingen.' }
      }
      const nameKey = `user:${user.username}`
      if (limiter.blocked(nameKey)) return TOO_MANY
      try {
        accounts.changeOwnPassword(user.id, current, next)
      } catch (error) {
        if (!(error instanceof AccountError)) throw error
        if (error.message.includes('huidige wachtwoord')) limiter.fail(nameKey)
        return { ok: false, status: error.code === 'not_found' ? 403 : 400, message: error.message }
      }
      return { ok: true, user, ...issue(user, accounts.sessionVersion(user.id) ?? 0) }
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
