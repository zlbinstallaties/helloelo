import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/*
 * Login sessions of the dashboard: a signed cookie, nothing is kept on the server per session. A token names the
 * account and the "session version" of that account; changing the version (password reset, account disabled)
 * ends every session of the account at once. No I/O besides the clock, so it is unit-tested in test/.
 */

export const SESSION_COOKIE = 'dig_dashboard'
const DEFAULT_TTL_MS = 12 * 60 * 60_000
const BASE64URL = /^[A-Za-z0-9_-]+$/

export interface SessionOptions {
  secret: string
  ttlMs?: number
  now?: () => number
}

export function createSessions(options: SessionOptions) {
  if (Buffer.byteLength(options.secret) < 32) throw new Error('session secret must be at least 32 bytes')
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now

  const sign = (payload: string) => createHmac('sha256', options.secret).update(payload).digest('base64url')

  return {
    ttlMs,
    issue(userId: string, version: number): string {
      const payload = [Buffer.from(userId).toString('base64url'), now() + ttlMs, version, randomBytes(9).toString('base64url')].join('.')
      return `${payload}.${sign(payload)}`
    },
    /** The account and session version of a valid, unexpired token; null for anything else. */
    verify(token: string | undefined): { userId: string; version: number } | null {
      if (!token) return null
      const parts = token.split('.')
      if (parts.length !== 5) return null
      const [encodedId, expires, version, nonce, signature] = parts
      if (!BASE64URL.test(encodedId) || !BASE64URL.test(nonce) || !/^\d+$/.test(expires) || !/^\d+$/.test(version)) return null
      const given = Buffer.from(signature)
      const expected = Buffer.from(sign(parts.slice(0, 4).join('.')))
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
      if (Number(expires) <= now()) return null
      return { userId: Buffer.from(encodedId, 'base64url').toString(), version: Number(version) }
    },
  }
}

export type Sessions = ReturnType<typeof createSessions>

export function sessionCookie(token: string, options: { maxAgeSeconds: number; secure: boolean }) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${options.maxAgeSeconds}; HttpOnly; SameSite=Strict${options.secure ? '; Secure' : ''}`
}

export function clearSessionCookie(secure: boolean) {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

export interface LoginLimiterOptions {
  max?: number
  windowMs?: number
  now?: () => number
  /** Upper bound on remembered keys, so a flood of different clients cannot grow the memory without limit. */
  maxKeys?: number
}

/** Counts failed logins per key (client address, or account name); blocks a key after `max` within `windowMs`. */
export function createLoginLimiter(options: LoginLimiterOptions = {}) {
  const max = options.max ?? 10
  const windowMs = options.windowMs ?? 15 * 60_000
  const now = options.now ?? Date.now
  const maxKeys = options.maxKeys ?? 10_000
  // Insertion order is order of last failure, so the oldest keys come first.
  const failures = new Map<string, number[]>()

  const recent = (key: string) => (failures.get(key) ?? []).filter((time) => now() - time < windowMs)

  return {
    blocked(key: string) {
      return recent(key).length >= max
    },
    fail(key: string) {
      const times = [...recent(key), now()]
      failures.delete(key)
      failures.set(key, times)
      for (const oldest of failures.keys()) {
        if (failures.size <= maxKeys) break
        failures.delete(oldest)
      }
    },
    reset(key: string) {
      failures.delete(key)
    },
    size() {
      return failures.size
    },
  }
}

export type LoginLimiter = ReturnType<typeof createLoginLimiter>
