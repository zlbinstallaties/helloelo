import { AccountsFileError } from './accounts.ts'
import { AvailabilityError, AvailabilityFileError } from './availability.ts'
import type { AvailabilityStore, OdooLink, Period } from './availability.ts'
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
 *
 * A period of a technician who is an Odoo employee is also sent to Odoo through the gateway (one record that says he is not
 * available; no shift, no planning). The period is the technician's own statement, so it stays in the dashboard whatever
 * Odoo says; what is known of the record is kept with it. Which employee and which record come from what was kept,
 * never from the request.
 */

const EMPLOYEE = /^employee:([1-9][0-9]{0,9})$/
/** The Odoo employee a technician account is linked to, or null (linked by name, or not at all). */
const employeeOf = (user: User) => {
  const match = user.personId ? EMPLOYEE.exec(user.personId) : null
  return match ? Number(match[1]) : null
}

/** What the screen is told about the record in Odoo: never the record number. */
const publicLink = (link: OdooLink | undefined) =>
  !link ? { state: 'none' as const } : link.state === 'synced' ? { state: 'synced' as const, verified: link.verified } : { state: link.state, message: link.message }

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

  /**
   * Sends one period to Odoo. `null`: nobody to send it for, or sending is switched off (the period stays in the
   * dashboard only); otherwise what is now known. The request id is the id of the period, so that sending it again
   * never makes a second record.
   */
  async function sendToOdoo(user: User, period: Period): Promise<{ link: OdooLink | null; offMessage?: string }> {
    const employeeId = employeeOf(user)
    if (employeeId === null) return { link: null }
    const outcome = await deps.addUnavailability({ requestId: period.id, employeeId, from: period.from, to: period.to, note: period.note })
    if (outcome.ok) return { link: { employeeId, state: 'synced', leaveId: outcome.leaveId, verified: outcome.verified } }
    if (outcome.kind === 'not_enabled') return { link: null, offMessage: outcome.message }
    return { link: { employeeId, state: outcome.kind === 'rejected' ? 'failed' : 'unknown', message: outcome.message.slice(0, 300) } }
  }

  const shown = (period: Period) => ({ id: period.id, from: period.from, to: period.to, note: period.note, odoo: publicLink(period.odoo) })

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
          periods: visible.map((period) => ({ ...shown(period), accountId: period.accountId, name: names.get(period.accountId) ?? '' })),
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
        let period = opened.store.add({ accountId: opened.user.id, from: body.body.from, to: body.body.to, note: body.body.note })
        const sent = await sendToOdoo(opened.user, period)
        if (sent.link) period = opened.store.setOdoo(period.id, sent.link)
        return json({ period: shown(period) }, 201)
      })
    },

    /** POST /api/availability/:id/retry: sends a period to Odoo again when it was refused or never sent. */
    availabilityRetry(request: Request, id: string): Promise<Response> {
      return guarded(async () => {
        const opened = open(request)
        if (!opened.ok) return opened.response
        if (opened.user.role !== 'monteur') return fail(403, ONLY_TECHNICIANS)
        const period = opened.store.find(id, opened.user.id)
        if (!period) return fail(404, 'Periode niet gevonden.')
        if (employeeOf(opened.user) === null) return fail(400, 'Je account hangt niet aan een medewerker in Odoo, dus deze periode kan niet naar Odoo.')
        if (period.odoo?.state === 'synced') return fail(409, 'Deze periode staat al in Odoo.')
        // The request id of the gateway is blocked after a silence: the record may exist, so it is not sent again.
        if (period.odoo?.state === 'unknown') return fail(409, 'Het is niet zeker of deze periode al in Odoo staat. Vraag de planner dat in Odoo (Planning) te controleren.')
        const sent = await sendToOdoo(opened.user, period)
        if (!sent.link) return fail(409, sent.offMessage ?? 'Het doorgeven aan Odoo staat niet aan op de server.')
        return json({ period: shown(opened.store.setOdoo(period.id, sent.link)) })
      })
    },

    /** DELETE /api/availability/:id: removes a period of the technician himself. */
    availabilityRemove(request: Request, id: string): Promise<Response> {
      return guarded(async () => {
        const opened = open(request)
        if (!opened.ok) return opened.response
        if (opened.user.role !== 'monteur') return fail(403, ONLY_TECHNICIANS)
        const period = opened.store.find(id, opened.user.id)
        if (!period) return fail(404, 'Periode niet gevonden.')
        // The record in Odoo goes first; if that does not work the period stays, so that nothing is left behind in Odoo.
        if (period.odoo?.state === 'synced') {
          const outcome = await deps.removeUnavailability({ employeeId: period.odoo.employeeId, leaveId: period.odoo.leaveId })
          if (!outcome.ok) {
            const status = outcome.kind === 'rejected' ? 502 : outcome.kind === 'unknown' ? 504 : 409
            const message = outcome.kind === 'not_enabled' ? 'Het verwijderen uit Odoo staat niet aan op de server, dus de periode blijft staan. Neem contact op met de beheerder.' : outcome.message
            return fail(status, message)
          }
        }
        opened.store.remove(id, opened.user.id)
        return json({
          ok: true,
          ...(period.odoo?.state === 'unknown' && { warning: 'Het is niet zeker of deze periode in Odoo stond. Controleer dat in Odoo (Planning); de periode is hier wel verwijderd.' }),
        })
      })
    },
  }
}
