import '@tanstack/react-start/server-only'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AccountsFileError, createAccountStore } from '#/lib/accounts'
import type { AccountIo } from '#/lib/accounts'
import { createAuth } from '#/lib/auth'
import { getDigDashboardData } from '#/lib/cache'
import { createJournal } from '#/lib/employee-journal'
import { JournalFileError } from '#/lib/employee-journal'
import { createEmployee, getEmployeeRoles, listPlanningRoles, setEmployeeRoles } from '#/lib/gateway.server'
import { createHandlers } from '#/lib/handlers'
import type { Handlers } from '#/lib/handlers'
import { generatePassword, isPasswordHash } from '#/lib/password'
import { createLoginLimiter, createSessions } from '#/lib/sessions'

/*
 * Connects the request handlers to the environment of the server. SERVER-ONLY.
 *
 *   DIG_AUTH               `off` switches logins off (previews and development: the dashboard is open and
 *                          read-only). Anything else: logins are required.
 *   DIG_SESSION_SECRET     at least 32 bytes; signs the session cookies. Without it the dashboard refuses
 *                          everything: it never falls back to being open.
 *   DIG_DATA_DIR           where the accounts are kept (default ./data); the directory must be writable and kept
 *   DIG_ADMIN_USERNAME     emergency admin (default `admin`), with
 *   DIG_ADMIN_PASSWORD_HASH  its password hash from `bun run preview:password`; works without the account file
 *   DIG_SECURE_COOKIES     `false` for plain http (default: secure in production)
 *   DIG_TRUST_PROXY        `true` when a proxy that we trust sets X-Forwarded-For (the last address is used)
 *   ODOO_PUBLIC_URL        only for links to Odoo forms
 *
 * Besides accounts.json the data directory holds employee-requests.json: the journal of "add a technician"
 * requests (no passwords), which is what recognises a repeated request.
 */

export const DEFAULT_ODOO_PUBLIC_URL = 'https://odoo20.srv1938209.hstgr.cloud'

export function authMode(): 'on' | 'off' {
  return process.env.DIG_AUTH === 'off' ? 'off' : 'on'
}

export function sessionSecretConfigured() {
  return Buffer.byteLength(process.env.DIG_SESSION_SECRET ?? '') >= 32
}

export function dataDir() {
  return path.resolve(process.env.DIG_DATA_DIR ?? 'data')
}

/** A JSON file written whole and atomically (temp file, then rename), readable by the server user only. */
export function fileIo(file: string, unreadable: () => Error): AccountIo {
  return {
    read() {
      try {
        return readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw unreadable()
      }
    },
    write(text) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, text, { mode: 0o600 })
      renameSync(temporary, file)
    },
  }
}

function clientAddress(request: Request) {
  if (process.env.DIG_TRUST_PROXY === 'true') {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    if (forwarded) return forwarded
  }
  const node = (request as unknown as { runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } } }).runtime?.node?.req?.socket
  return node?.remoteAddress ?? 'unknown'
}

let cached: Handlers | null = null

export function getHandlers(): Handlers {
  if (cached) return cached
  const mode = authMode()
  const secure = process.env.DIG_SECURE_COOKIES ? process.env.DIG_SECURE_COOKIES !== 'false' : process.env.NODE_ENV === 'production'
  let auth = null
  let accounts = null
  let journal = null
  if (mode === 'on') {
    if (!sessionSecretConfigured()) {
      console.error('DIG_SESSION_SECRET is missing or shorter than 32 bytes: every request is refused until it is set (or DIG_AUTH=off).')
    } else {
      const username = process.env.DIG_ADMIN_USERNAME || 'admin'
      const hash = process.env.DIG_ADMIN_PASSWORD_HASH
      if (hash && !isPasswordHash(hash)) console.error('DIG_ADMIN_PASSWORD_HASH is not a valid hash (make it with `bun run preview:password`): no emergency admin.')
      accounts = createAccountStore({
        io: fileIo(path.join(dataDir(), 'accounts.json'), () => new AccountsFileError('het bestand kan niet worden gelezen.')),
        reservedUsernames: [username],
      })
      journal = createJournal({ io: fileIo(path.join(dataDir(), 'employee-requests.json'), () => new JournalFileError('het bestand kan niet worden gelezen.')) })
      auth = createAuth({
        accounts,
        sessions: createSessions({ secret: process.env.DIG_SESSION_SECRET as string }),
        limiter: createLoginLimiter(),
        emergency: hash && isPasswordHash(hash) ? { username, passwordHash: hash } : null,
      })
    }
  }
  cached = createHandlers({
    authMode: mode,
    auth,
    accounts,
    journal,
    secureCookies: secure,
    clientAddress,
    loadData: (refresh) => (refresh ? getDigDashboardData.refresh() : getDigDashboardData()),
    odooBaseUrl: process.env.ODOO_PUBLIC_URL ?? DEFAULT_ODOO_PUBLIC_URL,
    createEmployee,
    listPlanningRoles,
    getEmployeeRoles,
    setEmployeeRoles,
    generatePassword,
  })
  return cached
}
