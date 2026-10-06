import { AccountError, AccountsFileError } from './accounts.ts'
import type { AccountChanges, PublicAccount, Role } from './accounts.ts'
import { buildAppointments, personHasId, planningPeople, technicianOptions } from './appointments.ts'
import { canCreateEmployees } from './authorization.ts'
import type { Guard } from './handlers.ts'
import type { Context } from './handlers.ts'
import { createTechnician } from './employee-service.ts'
import { JournalFileError } from './employee-journal.ts'
import type { DashboardAppointment } from './dashboard-types.ts'
import { accountFileProblem, fail, json, readJsonBody } from './http.ts'

/*
 * The admin part of the dashboard: add a technician (a new employee in Odoo plus a portal account) and manage the
 * accounts. Every function checks on the server, on every request, that the session is a logged-in admin; with
 * logins off none of this exists. Only listed fields are accepted: nothing about company, the responsible in Odoo,
 * the Odoo user, a model, a method or a stored hash can be sent from the browser.
 */

const statusOf = (error: AccountError) => (error.code === 'invalid' ? 400 : error.code === 'conflict' ? 409 : 404)

function unknownField(body: Record<string, unknown>, allowed: readonly string[]): Response | null {
  const extra = Object.keys(body).find((key) => !allowed.includes(key))
  return extra === undefined ? null : fail(400, `Onbekend veld: ${extra}.`)
}

export function createAdminHandlers(ctx: Context) {
  const { deps } = ctx

  /** Logins off: there are no accounts. Otherwise the person must be a logged-in admin. */
  function adminGuard(request: Request): Guard {
    if (deps.authMode === 'off') return { ok: false, response: fail(404, 'Accounts zijn er niet: inloggen staat uit.') }
    return ctx.guard(request, 'admin')
  }

  async function planning(): Promise<{ appointments: DashboardAppointment[]; error: string | null }> {
    try {
      return { appointments: buildAppointments(await deps.loadData(false), deps.odooBaseUrl), error: null }
    } catch (error) {
      return { appointments: [], error: error instanceof Error ? error.message : 'Odoo kon niet worden gelezen.' }
    }
  }

  function guarded(work: () => Promise<Response> | Response): Promise<Response> {
    return Promise.resolve()
      .then(work)
      .catch((error) => {
        if (error instanceof AccountsFileError) return accountFileProblem()
        if (error instanceof JournalFileError) return fail(500, 'Het aanvragenbestand is ongeldig; neem contact op met de beheerder.')
        if (error instanceof AccountError) return fail(statusOf(error), error.message)
        throw error
      })
  }

  /** The canonical id of a person of the planning, for an id as the browser sends it; null when nobody has it. */
  function canonicalPerson(appointments: DashboardAppointment[], personId: unknown) {
    if (typeof personId !== 'string') return null
    return planningPeople(appointments).find((person) => personHasId(person, personId)) ?? null
  }

  return {
    /** POST /api/employees: a technician as an employee in Odoo, without an Odoo user, and a portal account. */
    employeesCreate(request: Request): Promise<Response> {
      return guarded(async () => {
        const guard = adminGuard(request)
        if (!guard.ok) return guard.response
        if (!deps.accounts || !deps.journal) return fail(503, 'Inloggen is niet ingesteld op de server.')
        const body = await readJsonBody(request)
        if (!body.ok) return body.response
        const unknown = unknownField(body.body, ['requestId', 'name', 'username'])
        if (unknown) return unknown
        if (!canCreateEmployees(guard.user)) return fail(403, 'Geen toegang.')
        const result = await createTechnician(
          { accounts: deps.accounts, journal: deps.journal, createEmployee: deps.createEmployee, generatePassword: deps.generatePassword },
          guard.user,
          body.body,
        )
        if (!result.ok) {
          return json({ error: result.error, retry: result.retry, ...(result.employeeId !== undefined && { employeeId: result.employeeId }) }, result.status)
        }
        return json(
          { employeeId: result.employeeId, verified: result.verified, replayed: result.replayed, account: result.account, password: result.password },
          result.status,
        )
      })
    },

    /** GET /api/accounts: the accounts, and the people of the planning that an account can be linked to. */
    accountsList(request: Request): Promise<Response> {
      return guarded(async () => {
        const guard = adminGuard(request)
        if (!guard.ok) return guard.response
        if (!deps.accounts) return fail(503, 'Inloggen is niet ingesteld op de server.')
        const accounts = deps.accounts.list()
        const { appointments, error } = await planning()
        const people = planningPeople(appointments)
        return json({
          accounts: accounts.map((account) => {
            const person = account.personId ? people.find((item) => personHasId(item, account.personId as string)) : undefined
            // null: the planning could not be read, so it is not known.
            return { ...account, personName: person?.name ?? null, personInPlanning: error ? null : Boolean(person) }
          }),
          persons: technicianOptions(appointments).map((option) => {
            const person = people.find((item) => item.id === option.value)
            return { value: option.value, label: option.label, hasAccount: accounts.some((account) => account.personId !== null && person !== undefined && personHasId(person, account.personId)) }
          }),
          currentUserId: guard.user.id,
          planningError: error,
        })
      })
    },

    /** POST /api/accounts: an account for a person that is already in the planning (or another admin). */
    accountsCreate(request: Request): Promise<Response> {
      return guarded(async () => {
        const guard = adminGuard(request)
        if (!guard.ok) return guard.response
        if (!deps.accounts) return fail(503, 'Inloggen is niet ingesteld op de server.')
        const body = await readJsonBody(request)
        if (!body.ok) return body.response
        const unknown = unknownField(body.body, ['username', 'name', 'personId', 'role'])
        if (unknown) return unknown
        const role = (body.body.role ?? 'monteur') as Role
        let personId: string | null = null
        if (role === 'monteur') {
          const { appointments, error } = await planning()
          if (error) return fail(502, `De planning kon niet worden gelezen, dus de persoon kan niet worden gecontroleerd: ${error}`)
          const person = canonicalPerson(appointments, body.body.personId)
          if (!person) return fail(400, 'Onbekende persoon: kies iemand uit de planning.')
          if (deps.accounts.list().some((account) => account.personId !== null && personHasId(person, account.personId))) {
            return fail(409, 'Er is al een account voor deze persoon.')
          }
          personId = person.id
        } else if (body.body.personId !== undefined && body.body.personId !== null) {
          return fail(400, 'Een beheerder heeft geen persoon uit de planning nodig.')
        }
        const password = deps.generatePassword()
        const account = deps.accounts.create({ username: body.body.username as string, name: body.body.name as string, role, personId, password })
        return json({ account, password }, 201)
      })
    },

    /** PATCH /api/accounts/:id: name, person, role or disabled. Never the hash, never the session version. */
    accountsUpdate(request: Request, id: string): Promise<Response> {
      return guarded(async () => {
        const guard = adminGuard(request)
        if (!guard.ok) return guard.response
        if (!deps.accounts) return fail(503, 'Inloggen is niet ingesteld op de server.')
        const body = await readJsonBody(request)
        if (!body.ok) return body.response
        const unknown = unknownField(body.body, ['name', 'personId', 'role', 'disabled'])
        if (unknown) return unknown
        if (id === guard.user.id && (body.body.disabled !== undefined || body.body.role !== undefined)) {
          return fail(400, 'Je kunt je eigen account niet uitschakelen of van rol veranderen.')
        }
        const changes: AccountChanges = {}
        if (body.body.name !== undefined) changes.name = body.body.name as string
        if (body.body.disabled !== undefined) changes.disabled = body.body.disabled === true
        if (body.body.role !== undefined) changes.role = body.body.role as Role
        if (body.body.personId !== undefined) {
          if (body.body.personId === null) {
            changes.personId = null
          } else {
            const { appointments, error } = await planning()
            if (error) return fail(502, `De planning kon niet worden gelezen, dus de persoon kan niet worden gecontroleerd: ${error}`)
            const person = canonicalPerson(appointments, body.body.personId)
            if (!person) return fail(400, 'Onbekende persoon: kies iemand uit de planning.')
            if (deps.accounts.list().some((account) => account.id !== id && account.personId !== null && personHasId(person, account.personId))) {
              return fail(409, 'Er is al een account voor deze persoon.')
            }
            changes.personId = person.id
          }
        }
        return json({ account: deps.accounts.update(id, changes) as PublicAccount })
      })
    },

    /** POST /api/accounts/:id/password: a new generated password, shown once; their sessions end. */
    accountsResetPassword(request: Request, id: string): Promise<Response> {
      return guarded(async () => {
        const guard = adminGuard(request)
        if (!guard.ok) return guard.response
        if (!deps.accounts) return fail(503, 'Inloggen is niet ingesteld op de server.')
        if (id === guard.user.id) return fail(400, 'Wijzig je eigen wachtwoord via "Wachtwoord wijzigen".')
        const password = deps.generatePassword()
        deps.accounts.resetPassword(id, password)
        return json({ password })
      })
    },

    /** DELETE /api/accounts/:id */
    accountsRemove(request: Request, id: string): Promise<Response> {
      return guarded(async () => {
        const guard = adminGuard(request)
        if (!guard.ok) return guard.response
        if (!deps.accounts) return fail(503, 'Inloggen is niet ingesteld op de server.')
        if (id === guard.user.id) return fail(400, 'Je kunt je eigen account niet verwijderen.')
        deps.accounts.remove(id)
        return json({ ok: true })
      })
    },
  }
}
