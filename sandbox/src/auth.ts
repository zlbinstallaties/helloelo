import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/*
 * Login for previews: one shared password (stored as a scrypt hash) and a
 * signed, expiring session cookie. No user database in this phase.
 */

export const SESSION_COOKIE = 'dig_preview'
const SCRYPT_KEYLEN = 32

export function hashPassword(password: string, salt = randomBytes(16)): string {
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === SCRYPT_KEYLEN && timingSafeEqual(actual, expected)
}

export interface SessionOptions {
  secret: string
  ttlMs?: number
  now?: () => number
}

export function createSessions(options: SessionOptions) {
  if (Buffer.byteLength(options.secret) < 32) throw new Error('session secret must be at least 32 bytes')
  const ttlMs = options.ttlMs ?? 12 * 60 * 60_000
  const now = options.now ?? Date.now

  function sign(payload: string) {
    return createHmac('sha256', options.secret).update(payload).digest('base64url')
  }

  return {
    ttlMs,
    issue(): string {
      const payload = `${now() + ttlMs}.${randomBytes(9).toString('base64url')}`
      return `${payload}.${sign(payload)}`
    },
    valid(token: string | undefined): boolean {
      if (!token) return false
      const parts = token.split('.')
      if (parts.length !== 3) return false
      const payload = `${parts[0]}.${parts[1]}`
      const given = Buffer.from(parts[2])
      const expected = Buffer.from(sign(payload))
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
      return Number(parts[0]) > now()
    },
  }
}

export type Sessions = ReturnType<typeof createSessions>

/** Counts failed logins per client; blocks after `max` within `windowMs`. */
export function createLoginLimiter(max = 10, windowMs = 15 * 60_000, now: () => number = Date.now) {
  const failures = new Map<string, number[]>()
  return {
    blocked(client: string) {
      const recent = (failures.get(client) ?? []).filter((t) => now() - t < windowMs)
      failures.set(client, recent)
      return recent.length >= max
    },
    fail(client: string) {
      failures.set(client, [...(failures.get(client) ?? []), now()])
    },
    reset(client: string) {
      failures.delete(client)
    },
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return cookies
}

/** The Cookie header without our session cookie, so apps never see it. */
export function stripSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined
  const rest = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${SESSION_COOKIE}=`))
  return rest.length ? rest.join('; ') : undefined
}
