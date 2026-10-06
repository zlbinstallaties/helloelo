import { OdooWriteError, type OdooClient } from '../../src/lib/odoo-client.ts'
import { GatewayError } from './errors.ts'
import type { Project } from './projects.ts'

/*
 * The named actions of the gateway. Today there is one: create a technician as an Odoo employee WITHOUT an Odoo
 * user, so that the planner can plan them in Odoo Planning. This is the only write the gateway has.
 *
 * What the caller sends is only a request id and a name. Company, the Odoo user who is responsible, the values of
 * the record and the model are fixed here or in the project config; the request cannot change them.
 *
 * Repeating a request must never make a second employee:
 *  - the same request id gives the same answer, without asking Odoo again;
 *  - while a request runs, a repeat is refused;
 *  - if the outcome of the call to Odoo is unknown (time-out, network), the request id is blocked: the employee
 *    may exist, so the caller has to look in Odoo instead of trying again;
 *  - only when Odoo itself answered with an error is trying again allowed.
 * This memory lives in this process (24 hours): after a restart the caller's own journal is the safeguard.
 */

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/
const ENTRY_TTL_MS = 24 * 60 * 60_000
const MAX_ENTRIES = 1000
const HOUR_MS = 60 * 60_000

export interface ActionContext {
  requestId?: string
  employeeId?: number
}

type Entry = {
  name: string
  state: 'pending' | 'done' | 'unknown'
  result?: { id: number; name: string; verified: boolean }
  failure?: GatewayError
  expires: number
}

export function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new GatewayError(400, 'invalid_request_id', 'requestId must be 16 to 64 letters, digits, - or _')
  }
  return value
}

export function validateEmployeeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  const hasControl = [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  if (name.length < 1 || name.length > 80 || hasControl) {
    throw new GatewayError(400, 'invalid_name', 'name must be 1 to 80 characters without control characters')
  }
  return name
}

function amsterdamDate(ms: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date(ms))
}

export function createActions(options: { odoo: OdooClient; now: () => number }) {
  const { odoo, now } = options
  const entries = new Map<string, Entry>()
  const attempts = new Map<string, number[]>()

  function remember(key: string, entry: Entry) {
    entries.set(key, entry)
    for (const [oldKey, old] of entries) {
      if (entries.size <= MAX_ENTRIES) break
      if (old.state !== 'pending') entries.delete(oldKey)
    }
  }

  function limitReached(project: Project, perHour: number) {
    const recent = (attempts.get(project.id) ?? []).filter((time) => now() - time < HOUR_MS)
    attempts.set(project.id, recent)
    return recent.length >= perHour
  }

  return {
    async createEmployee(project: Project, body: Record<string, unknown>, ctx: ActionContext) {
      const policy = project.actions.createEmployee
      if (!policy) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: createEmployee')
      const extra = Object.keys(body).filter((key) => key !== 'requestId' && key !== 'name')
      if (extra.length > 0) throw new GatewayError(400, 'unknown_parameter', `unknown parameter: ${extra[0]}`)
      const requestId = validateRequestId(body.requestId)
      const name = validateEmployeeName(body.name)
      ctx.requestId = requestId

      const key = `${project.id}:${requestId}`
      const known = entries.get(key)
      if (known && known.expires > now()) {
        if (known.name !== name) throw new GatewayError(409, 'request_id_reused', 'this requestId was used for another name')
        if (known.state === 'pending') throw new GatewayError(409, 'in_progress', 'this request is still running')
        if (known.state === 'unknown') {
          throw new GatewayError(409, 'outcome_unknown', 'it is not known whether the employee was created; look in Odoo')
        }
        if (known.result) ctx.employeeId = known.result.id
        if (known.failure) throw known.failure
        return { ...known.result, replayed: true }
      }

      const entry: Entry = { name, state: 'pending', expires: now() + ENTRY_TTL_MS }
      remember(key, entry)
      let attempted = false
      try {
        // The responsible is checked on every request: users get archived or leave the company.
        const check = await odoo.checkResponsible({ userId: policy.responsibleUserId, companyId: project.companyId })
        if (!check.exists || !check.active || !check.internal || !check.inCompany) {
          const why = !check.exists ? 'does not exist' : !check.active ? 'is not active' : !check.internal ? 'is not an internal user' : 'is not in the company'
          throw new GatewayError(409, 'responsible_not_allowed', `the configured responsible ${why}`)
        }
        if (limitReached(project, policy.maxPerHour)) {
          throw new GatewayError(429, 'rate_limited', `at most ${policy.maxPerHour} employees per hour`)
        }
        attempts.set(project.id, [...(attempts.get(project.id) ?? []), now()])

        attempted = true
        let id: number
        try {
          id = await odoo.createEmployee({
            name,
            companyId: project.companyId,
            responsibleUserId: policy.responsibleUserId,
            dateVersion: amsterdamDate(now()),
          })
        } catch (error) {
          if (error instanceof OdooWriteError && error.outcome === 'rejected') {
            entries.delete(key)
            throw new GatewayError(502, 'odoo_rejected', error.odooName ?? `upstream status ${error.status}`)
          }
          entry.state = 'unknown'
          throw new GatewayError(504, 'outcome_unknown', 'it is not known whether the employee was created; look in Odoo')
        }
        ctx.employeeId = id

        // Read back what Odoo made: the technician must have no Odoo user and must be in the company.
        let verified = false
        try {
          const record = await odoo.readEmployee({ id, companyId: project.companyId })
          if (record && (record.userId !== null || record.companyId !== project.companyId)) {
            entry.state = 'done'
            entry.failure = new GatewayError(500, 'employee_invariant_violated', 'the employee was created but is not as intended', { id })
            throw entry.failure
          }
          verified = record !== null
        } catch (error) {
          if (error instanceof GatewayError) throw error
          // Reading back failed: the employee was created (Odoo confirmed the id), it is just not verified.
        }
        entry.state = 'done'
        entry.result = { id, name, verified }
        return entry.result
      } catch (error) {
        if (!attempted) entries.delete(key)
        throw error
      }
    },
  }
}
