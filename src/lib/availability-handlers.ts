import { AccountsFileError } from './accounts.ts'
import { AvailabilityError, AvailabilityFileError } from './availability.ts'
import type { AvailabilityStore, Period } from './availability.ts'
import type { Context } from './handlers.ts'
import { accountFileProblem, fail, json, readJsonBody, unknownField } from './http.ts'
import type { User } from './authorization.ts'

/*
 * The availability part of the dashboard: a technician gives the periods in which he is NOT available, the planner
 * sees them of everyone. Every request is checked on the server, on every request:
 *
 * - a technician reads, adds and removes his OWN periods only. Whose period it is comes from his session, never from
 *   the request: the only fields a request may have are `from`, `to` and `note`. The period of someone else looks
 *   like it does not exist;
 * - the planner reads every period and changes none;
 * - with logins off none of this exists.
 */

const statusOf = (error: AvailabilityError) => (error.code === 'invalid' ? 400 : error.code === 'not_found' ? 404 : 409)

export function createAvailabilityHandlers(ctx: Context) {
  const { deps } = ctx

  type Opened = { ok: true; user: User; store: AvailabilityStore } | { ok: false; response: Response }

  function open(request: Request): Opened {
    if (deps.authMode === 'off') return { ok: false, response: fail(404, 'Beschikbaarheid doorgeven kan niet: inloggen staat uit.') }
    const guard = ctx.guard(request)
    if (!guard.ok) return guard
    if (!deps.accounts || !deps.availability) return { ok: false, response: fail(503, 'Inloggen is niet ingesteld op de server.') }
    return { ok: true, user: guard.user, store: deps.availability }
  }

  function guarded(work: () => Promise<Response> | Response): Promise<Response> {
    return Promise.resolve()
      .then(work)
      .catch((error) => {
        if (error instanceof AccountsFileError) return accountFileProblem()
        if (error instanceof AvailabilityFileError) return fail(500, 'Het beschikbaarheidsbestand is ongeldig; neem contact op met de beheerder.')
        if (error instanceof AvailabilityError) return fail(statusOf(error), error.message)
        throw error
      })
  }

  const ONLY_TECHNICIANS = 'Alleen een monteur geeft zijn eigen beschikbaarheid door.'

  return {
    /** GET /api/availability: a technician gets his own periods, the planner everyone's. Only periods that have not ended. */
    availabilityList(request: Request): Promise<Response> {
      return guarded(() => {
        const opened = open(request)
        if (!opened.ok) return opened.response
        const today = opened.store.today()
        const names = new Map((deps.accounts?.list() ?? []).map((account) => [account.id, account.name]))
        const own = opened.user.role === 'monteur'
        const visible = opened.store
          .list()
          .filter((period: Period) => period.to >= today && (own ? period.accountId === opened.user.id : names.has(period.accountId)))
        return json({
          today,
          canEdit: own,
          periods: visible.map((period) => ({ id: period.id, accountId: period.accountId, name: names.get(period.accountId) ?? '', from: period.from, to: period.to, note: period.note })),
        })
      })
    },

    /** POST /api/availability {from, to, note?}: a period in which the technician is not available. */
    availabilityAdd(request: Request): Promise<Response> {
      return guarded(async () => {
        const opened = open(request)
        if (!opened.ok) return opened.response
        if (opened.user.role !== 'monteur') return fail(403, ONLY_TECHNICIANS)
        const body = await readJsonBody(request)
        if (!body.ok) return body.response
        const unknown = unknownField(body.body, ['from', 'to', 'note'])
        if (unknown) return unknown
        const period = opened.store.add({ accountId: opened.user.id, from: body.body.from, to: body.body.to, note: body.body.note })
        return json({ period: { id: period.id, from: period.from, to: period.to, note: period.note } }, 201)
      })
    },

    /** DELETE /api/availability/:id: removes a period of the technician himself. */
    availabilityRemove(request: Request, id: string): Promise<Response> {
      return guarded(() => {
        const opened = open(request)
        if (!opened.ok) return opened.response
        if (opened.user.role !== 'monteur') return fail(403, ONLY_TECHNICIANS)
        opened.store.remove(id, opened.user.id)
        return json({ ok: true })
      })
    },
  }
}
