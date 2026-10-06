import { AccountsFileError } from './accounts.ts'
import type { AccountStore } from './accounts.ts'
import { buildAppointments, filterByTechnician, inScope } from './appointments.ts'
import type { Auth } from './auth.ts'
import { canManageAccounts, canRefresh, technicianChoicesFor, visibleAppointments } from './authorization.ts'
import type { User } from './authorization.ts'
import type { DashboardData, DashboardResponse } from './dashboard-types.ts'
import type { Journal } from './employee-journal.ts'
import type { GatewayOutcome, PlanningRolesOutcome } from './gateway-employee.ts'
import { GatewayError } from './gateway-error.ts'
import { createAdminHandlers } from './admin-handlers.ts'
import { accountFileProblem, fail, json, readJsonBody } from './http.ts'
import { clearSessionCookie, readCookie, SESSION_COOKIE, sessionCookie } from './sessions.ts'

/*
 * The request handlers of the dashboard: plain functions from a Request to a Response, with everything they
 * depend on passed in. The route files only connect them to the environment. Because of that, login, rights and
 * the dashboard answer are unit-tested with mocks in test/handlers.test.ts, without a server.
 *
 * Every request is checked again on the server: the session cookie, the account (still there, still enabled,
 * same session version) and the role. Nothing the browser sends decides who someone is or what they may see.
 */

export interface HandlerDeps {
  /** `on`: login required. `off`: no logins at all (previews, development); the dashboard is open and read-only. */
  authMode: 'on' | 'off'
  /** Null when logins are on but the server is not set up for them: then everything is refused. */
  auth: Auth | null
  accounts: AccountStore | null
  /** The journal of "add a technician" requests; null together with `auth`. */
  journal: Journal | null
  secureCookies: boolean
  clientAddress: (request: Request) => string
  loadData: (refresh: boolean) => Promise<DashboardData>
  odooBaseUrl: string
  /** Asks the gateway to create the employee. Only a request id and a name go out; nothing else can. */
  createEmployee: (input: { requestId: string; name: string; planningRoleIds?: readonly number[] }) => Promise<GatewayOutcome>
  /** The planning roles a planner can give a new employee (read from Odoo through the gateway). */
  listPlanningRoles: () => Promise<PlanningRolesOutcome>
  generatePassword: () => string
}

/** Who the dashboard shows to when logins are off: the old, open behaviour, but never able to change anything. */
const LOCAL: User = { id: 'local', username: 'local', name: 'Lokaal', role: 'admin', personId: null, emergency: false }

const NOT_SET_UP = 'Inloggen is niet ingesteld op de server (DIG_SESSION_SECRET), of staat uit (DIG_AUTH=off).'

export const publicUser = (user: User) => ({
  id: user.id,
  username: user.username,
  name: user.name,
  role: user.role,
  personId: user.personId,
  emergency: user.emergency,
})

export type Guard = { ok: true; user: User } | { ok: false; response: Response }

export function createContext(deps: HandlerDeps) {
  /**
   * Who is asking. Logins off: the local viewer. Logins on: the person of the session cookie, after the header
   * check for requests that change something (a cross-site form or script cannot add that header).
   */
  function guard(request: Request, level: 'user' | 'admin' = 'user'): Guard {
    if (deps.authMode === 'off') return { ok: true, user: LOCAL }
    if (!deps.auth) return { ok: false, response: fail(503, NOT_SET_UP) }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('x-dig-dashboard') !== '1') {
      return { ok: false, response: fail(403, 'Ongeldig verzoek.') }
    }
    let user: User | null
    try {
      user = deps.auth.userFromToken(readCookie(request.headers.get('cookie'), SESSION_COOKIE))
    } catch (error) {
      if (error instanceof AccountsFileError) return { ok: false, response: accountFileProblem() }
      throw error
    }
    if (!user) return { ok: false, response: fail(401, 'Niet ingelogd.') }
    if (level === 'admin' && !canManageAccounts(user)) return { ok: false, response: fail(403, 'Geen toegang.') }
    return { ok: true, user }
  }
  return { deps, guard }
}

export type Context = ReturnType<typeof createContext>

function dashboardError(error: unknown) {
  const status = error instanceof GatewayError && error.status === 503 ? 503 : 502
  return fail(status, error instanceof Error ? error.message : 'Odoo kon niet worden gelezen.')
}

function respond(request: Request, user: User, data: DashboardData, odooBaseUrl: string) {
  const url = new URL(request.url)
  const requestedDate = url.searchParams.get('date') ?? ''
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    ? requestedDate
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date())
  const requestedScope = url.searchParams.get('scope')
  const scope: DashboardResponse['scope'] = requestedScope === 'upcoming' || requestedScope === 'all' ? requestedScope : 'day'
  const technician = url.searchParams.get('technician') ?? ''

  const all = buildAppointments(data, odooBaseUrl)
  // What this person may see comes first; period and technician only narrow that down further.
  const mine = visibleAppointments(user, all).filter((appointment) => inScope(appointment, date, scope))
  const appointments = user.role === 'admin' ? filterByTechnician(mine, technician) : mine
  return json({
    company: data.company,
    appointments,
    technicians: technicianChoicesFor(user, all),
    scope,
    date,
    truncated: data.truncated,
    loadedAt: data.loadedAt,
  } satisfies DashboardResponse)
}

export function createHandlers(deps: HandlerDeps) {
  const ctx = createContext(deps)

  return {
    ctx,
    ...createAdminHandlers(ctx),

    async login(request: Request): Promise<Response> {
      if (deps.authMode === 'off') return fail(404, 'Inloggen staat uit.')
      if (!deps.auth) return fail(503, NOT_SET_UP)
      if (request.headers.get('x-dig-dashboard') !== '1') return fail(403, 'Ongeldig verzoek.')
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      let result
      try {
        result = deps.auth.login({ username: body.body.username, password: body.body.password, client: deps.clientAddress(request) })
      } catch (error) {
        if (error instanceof AccountsFileError) return accountFileProblem()
        throw error
      }
      if (!result.ok) return fail(result.status, result.message)
      return json({ user: publicUser(result.user) }, 200, {
        'set-cookie': sessionCookie(result.token, { maxAgeSeconds: result.maxAgeSeconds, secure: deps.secureCookies }),
      })
    },

    async logout(request: Request): Promise<Response> {
      if (deps.authMode === 'off') return fail(404, 'Inloggen staat uit.')
      if (!deps.auth) return fail(503, NOT_SET_UP)
      if (request.headers.get('x-dig-dashboard') !== '1') return fail(403, 'Ongeldig verzoek.')
      return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(deps.secureCookies) })
    },

    async me(request: Request): Promise<Response> {
      if (deps.authMode === 'off') {
        return json({ authMode: 'off', user: null, canRefresh: true, canManageAccounts: false, canCreateEmployees: false })
      }
      if (!deps.auth) return fail(503, NOT_SET_UP)
      let user: User | null
      try {
        user = deps.auth.userFromToken(readCookie(request.headers.get('cookie'), SESSION_COOKIE))
      } catch (error) {
        if (error instanceof AccountsFileError) return accountFileProblem()
        throw error
      }
      return json({
        authMode: 'on',
        user: user ? publicUser(user) : null,
        canRefresh: user ? canRefresh(user) : false,
        canManageAccounts: user ? canManageAccounts(user) : false,
        canCreateEmployees: user ? canManageAccounts(user) : false,
      })
    },

    async changePassword(request: Request): Promise<Response> {
      const guarded = ctx.guard(request)
      if (!guarded.ok) return guarded.response
      if (!deps.auth || deps.authMode === 'off') return fail(404, 'Inloggen staat uit.')
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const { current, next } = body.body
      if (typeof current !== 'string' || typeof next !== 'string') return fail(400, 'Vul het huidige en het nieuwe wachtwoord in.')
      let result
      try {
        result = deps.auth.changePassword(guarded.user, current, next)
      } catch (error) {
        if (error instanceof AccountsFileError) return accountFileProblem()
        throw error
      }
      if (!result.ok) return fail(result.status, result.message)
      return json({ ok: true }, 200, {
        'set-cookie': sessionCookie(result.token, { maxAgeSeconds: result.maxAgeSeconds, secure: deps.secureCookies }),
      })
    },

    async dashboardGet(request: Request): Promise<Response> {
      const guarded = ctx.guard(request)
      if (!guarded.ok) return guarded.response
      let data: DashboardData
      try {
        data = await deps.loadData(false)
      } catch (error) {
        return dashboardError(error)
      }
      return respond(request, guarded.user, data, deps.odooBaseUrl)
    },

    /** Refreshing reads everything from Odoo again, so only people who may do that. */
    async dashboardRefresh(request: Request): Promise<Response> {
      const guarded = ctx.guard(request)
      if (!guarded.ok) return guarded.response
      if (!canRefresh(guarded.user)) return fail(403, 'Geen toegang.')
      let data: DashboardData
      try {
        data = await deps.loadData(true)
      } catch (error) {
        return dashboardError(error)
      }
      return respond(request, guarded.user, data, deps.odooBaseUrl)
    },
  }
}

export type Handlers = ReturnType<typeof createHandlers>
