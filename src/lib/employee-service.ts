import { AccountError, AccountsFileError, normalizeUsername } from './accounts.ts'
import type { AccountStore, PublicAccount } from './accounts.ts'
import { canCreateEmployees } from './authorization.ts'
import type { User } from './authorization.ts'
import { JournalError, JournalFileError } from './employee-journal.ts'
import type { Journal, JournalEntry } from './employee-journal.ts'
import type { GatewayOutcome } from './gateway-employee.ts'

/*
 * "Add a technician": the planner gives a name and a user name; the dashboard makes the technician an employee in
 * Odoo (so that they can be planned in Odoo Planning; nothing is planned from here) and gives them a portal
 * account, linked to that employee by its Odoo id. The technician gets no Odoo account.
 *
 * The order is what keeps this safe, and every step is written in the journal:
 *   1. who may do this; check the input and the future account BEFORE Odoo is asked;
 *   2. write the request in the journal, then ask Odoo (through the gateway);
 *   3. only when Odoo confirmed the employee, make the portal account: personId `employee:<odoo id>`;
 *   4. a failed or unclear Odoo answer never leaves a local account behind;
 *   5. a repeat of a request is recognised by its request id and never asks Odoo for a second employee.
 * No I/O of its own besides what is passed in, so it is unit-tested with mocks in test/.
 */

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/
const STALE_CREATING_MS = 2 * 60_000

export interface EmployeeServiceDeps {
  accounts: AccountStore
  journal: Journal
  createEmployee: (input: { requestId: string; name: string }) => Promise<GatewayOutcome>
  generatePassword: () => string
  now?: () => Date
}

export type TechnicianResult =
  | {
      ok: true
      status: 200 | 201
      employeeId: number
      /** Odoo confirmed the id and reading it back showed no Odoo user and the right company. */
      verified: boolean
      /** An earlier request with this id had already finished; nothing new was made. */
      replayed: boolean
      /** The portal account; null when it was removed after an earlier request. */
      account: PublicAccount | null
      /** The first password, shown once; null for a repeat. */
      password: string | null
    }
  | {
      ok: false
      status: number
      error: string
      employeeId?: number
      /**
       * `safe`: the same request may be sent again (nothing was made, or only the account is missing).
       * `blocked`: it is not known what Odoo did, or an employee exists that is not as intended: look in Odoo first,
       * and only then start a new request.
       */
      retry: 'safe' | 'blocked'
    }

const fail = (status: number, error: string, employeeId?: number, retry: 'safe' | 'blocked' = 'safe'): TechnicianResult => ({
  ok: false,
  status,
  error,
  retry,
  ...(employeeId !== undefined && { employeeId }),
})

const UNKNOWN_MESSAGE =
  'Het is niet zeker of de medewerker in Odoo is aangemaakt. Zoek de naam in Odoo en controleer dat voordat je het opnieuw probeert; deze aanvraag wordt niet nog eens naar Odoo gestuurd.'

function statusOf(error: AccountError) {
  return error.code === 'invalid' ? 400 : error.code === 'conflict' ? 409 : 404
}

export async function createTechnician(deps: EmployeeServiceDeps, user: User, input: { requestId?: unknown; name?: unknown; username?: unknown }): Promise<TechnicianResult> {
  if (!canCreateEmployees(user)) return fail(403, 'Geen toegang.')
  const now = deps.now ?? (() => new Date())

  const requestId = typeof input.requestId === 'string' && REQUEST_ID.test(input.requestId) ? input.requestId : null
  if (!requestId) return fail(400, 'De aanvraag is ongeldig: het aanvraag-id ontbreekt of heeft een verkeerde vorm.')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const username = normalizeUsername(input.username)

  try {
    const entry = deps.journal.get(requestId)
    if (entry) return await continueRequest(deps, now, entry, name, username)

    // 1. A new request. Everything that can be checked now is checked, so that no employee is made for an account
    //    that cannot follow.
    let checked: { username: string; name: string }
    try {
      checked = deps.accounts.precheck({ username, name })
    } catch (error) {
      if (error instanceof AccountError) return fail(statusOf(error), error.message)
      throw error
    }

    // 2. Written down before Odoo hears about it. Nothing is asked if this cannot be written.
    deps.journal.begin({ requestId, name: checked.name, username: checked.username, by: user.id })
    const outcome = await deps.createEmployee({ requestId, name: checked.name })

    switch (outcome.kind) {
      case 'created':
        try {
          deps.journal.markCreated(requestId, outcome.id, outcome.verified)
        } catch {
          return fail(500, `In Odoo is medewerker ${outcome.id} aangemaakt, maar dat kon niet worden vastgelegd. Er is nog geen account gemaakt; neem contact op met de beheerder.`, outcome.id)
        }
        return await finishAccount(deps, requestId, outcome.id, outcome.verified, checked.name, checked.username)
      case 'rejected':
        deps.journal.remove(requestId)
        return fail(502, outcome.message)
      case 'not_enabled':
        deps.journal.remove(requestId)
        return fail(503, outcome.message)
      case 'invariant':
        deps.journal.markUnknown(requestId, outcome.id)
        return fail(500, outcome.message, outcome.id, 'blocked')
      default:
        deps.journal.markUnknown(requestId)
        return fail(504, outcome.message, undefined, 'blocked')
    }
  } catch (error) {
    return unexpected(error)
  }
}

function unexpected(error: unknown): TechnicianResult {
  if (error instanceof AccountsFileError) return fail(500, 'Het accountbestand is ongeldig; neem contact op met de beheerder.')
  if (error instanceof JournalFileError) return fail(500, 'Het aanvragenbestand is ongeldig; neem contact op met de beheerder.')
  if (error instanceof JournalError && error.code === 'exists') return fail(409, 'Deze aanvraag wordt al verwerkt.')
  return fail(500, 'Het aanmaken is niet gelukt door een fout op de server. Controleer in Odoo of de medewerker is aangemaakt voordat je het opnieuw probeert.')
}

/** A request id that was seen before: repeat, still running, unsure, or half done. */
async function continueRequest(deps: EmployeeServiceDeps, now: () => Date, entry: JournalEntry, name: string, username: string): Promise<TechnicianResult> {
  // Only while the account is still missing may the user name change; the name never may.
  if (entry.name !== name || (entry.state !== 'created' && entry.username !== username)) {
    return fail(409, 'Deze aanvraag hoort bij een andere naam of gebruikersnaam.')
  }
  switch (entry.state) {
    case 'done':
      return {
        ok: true,
        status: 200,
        employeeId: entry.employeeId as number,
        verified: entry.verified === true,
        replayed: true,
        account: entry.accountId ? (deps.accounts.get(entry.accountId) ?? null) : null,
        password: null,
      }
    case 'creating':
      // A request that has been "creating" for long was cut off (a restart): what Odoo did is not known.
      if (now().getTime() - Date.parse(entry.updatedAt) <= STALE_CREATING_MS) return fail(409, 'Deze aanvraag wordt al verwerkt.')
      deps.journal.markUnknown(entry.requestId)
      return fail(409, UNKNOWN_MESSAGE, undefined, 'blocked')
    case 'unknown':
      return fail(409, entry.employeeId ? `In Odoo bestaat medewerker ${entry.employeeId}, maar niet zoals bedoeld. Controleer en herstel dat in Odoo; er wordt niets nieuws aangemaakt.` : UNKNOWN_MESSAGE, entry.employeeId, 'blocked')
    default:
      // created: the employee exists, only the account is missing.
      return finishAccount(deps, entry.requestId, entry.employeeId as number, entry.verified === true, entry.name, username)
  }
}

/** Step 3: the portal account, only now that Odoo confirmed the employee. */
async function finishAccount(deps: EmployeeServiceDeps, requestId: string, employeeId: number, verified: boolean, name: string, username: string): Promise<TechnicianResult> {
  const personId = `employee:${employeeId}`
  const prefix = `In Odoo is medewerker ${employeeId} aangemaakt, maar het account kon niet worden gemaakt`

  // The account may exist already (the step after it was cut off): then the request is simply done.
  const existing = deps.accounts.findByPerson(personId)
  if (existing) {
    deps.journal.markDone(requestId, existing.id)
    return { ok: true, status: 200, employeeId, verified, replayed: true, account: existing, password: null }
  }

  const password = deps.generatePassword()
  let account: PublicAccount
  try {
    if (deps.journal.get(requestId)?.username !== username) deps.journal.setUsername(requestId, username)
    account = deps.accounts.create({ username, name, role: 'monteur', personId, password })
  } catch (error) {
    if (error instanceof AccountError) {
      return fail(statusOf(error) === 404 ? 500 : statusOf(error), `${prefix}: ${error.message} Los dat op en stuur dezelfde aanvraag opnieuw (eventueel met een andere gebruikersnaam); Odoo wordt dan niet nog eens gevraagd.`, employeeId)
    }
    if (error instanceof AccountsFileError) return fail(500, `${prefix}: het accountbestand is ongeldig. Neem contact op met de beheerder.`, employeeId)
    return fail(500, `${prefix}: het account kon niet worden opgeslagen. Stuur dezelfde aanvraag opnieuw; Odoo wordt dan niet nog eens gevraagd.`, employeeId)
  }
  try {
    deps.journal.markDone(requestId, account.id)
  } catch {
    // The account exists and the password is in hand: the job is done. A repeat finds the account by its person.
  }
  return { ok: true, status: 201, employeeId, verified, replayed: false, account, password }
}
