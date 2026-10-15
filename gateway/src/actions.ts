import { OdooWriteError, type OdooClient } from '../../src/lib/odoo-client.ts'
import { GatewayError } from './errors.ts'
import type { Project } from './projects.ts'
import { createHash } from 'node:crypto'
import { dayRangeInUtc, isTimeZone } from './zoned.ts'

/*
 * The named actions of the gateway. Today there is one: create a technician as an Odoo employee WITHOUT an Odoo
 * user, so that the planner can plan them in Odoo Planning. This is the only write the gateway has.
 *
 * What the caller sends is a request id, a name and, optionally, the planning roles (up to 5 `planning.role` ids).
 * Company, the Odoo user who is responsible, the other values of the record and the model are fixed here or in the
 * project config; the request cannot change them. A role is checked in Odoo (it exists and is active) and, when the
 * project limits them, against the allowed list.
 *
 * Repeating a request must never make a second employee:
 *  - the same request id gives the same answer, without asking Odoo again;
 *  - while a request runs, a repeat is refused;
 *  - if the outcome of the call to Odoo is unknown (time-out, network), the request id is blocked: the employee
 *    may exist, so the caller has to look in Odoo instead of trying again;
 *  - only when Odoo itself answered with an error is trying again allowed.
 * This memory lives in this process (24 hours): after a restart the caller's own journal is the safeguard.
 *
 * The same holds for marking an employee as not available (`addEmployeeUnavailability`): one record of
 * `resource.calendar.leaves` for the resource of ONE employee, in whole days of his own time zone, with a name that
 * starts with a fixed marker. Removing (`removeEmployeeUnavailability`) only ever touches a record that has that marker
 * and belongs to the resource of the employee that is named, so it cannot remove a holiday, a record made by hand in
 * Odoo, or the record of someone else.
 */

/** The records a document can be tied to; the customer is read from the record, never given by the caller. */
const DOCUMENT_REFERENCES = ['planning.slot', 'svs.tech.visit'] as const
/** A PDF is at most 8 MiB; as base64 that is a little under 11.2 million characters. */
export const MAX_PDF_BYTES = 8 * 1024 * 1024
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.pdf$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

type DocumentEntry = {
  same: string
  state: 'pending' | 'done' | 'unknown'
  result?: { id: number; noted: boolean; customer: string | null }
  expires: number
}

/** What every record made by the dashboard starts with; it is what removing recognises its own records by. */
export const UNAVAILABILITY_MARKER = '[Dashboard] Niet beschikbaar'
const MAX_NOTE = 200
const MAX_SPAN_DAYS = 366

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/
const ENTRY_TTL_MS = 24 * 60 * 60_000
const MAX_ENTRIES = 1000
const HOUR_MS = 60 * 60_000

export interface ActionContext {
  requestId?: string
  employeeId?: number
}

type UnavailabilityEntry = {
  /** The request as it was understood; a repeat must be the same request. */
  same: string
  state: 'pending' | 'done' | 'unknown'
  result?: { id: number; employeeId: number; from: string; to: string; verified: boolean }
  expires: number
}

type Entry = {
  name: string
  roles: number[]
  state: 'pending' | 'done' | 'unknown'
  result?: { id: number; name: string; verified: boolean; planningRoles: number }
  failure?: GatewayError
  expires: number
}

export function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new GatewayError(400, 'invalid_request_id', 'requestId must be 16 to 64 letters, digits, - or _')
  }
  return value
}

const MAX_ROLES_PER_EMPLOYEE = 5

/** The planning roles of a request: absent means none; otherwise a short list of different positive integers. */
export function validatePlanningRoleIds(value: unknown): number[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > MAX_ROLES_PER_EMPLOYEE ||
    value.some((id) => !Number.isInteger(id) || id <= 0) ||
    new Set(value).size !== value.length
  ) {
    throw new GatewayError(400, 'invalid_planning_roles', `planningRoleIds must be at most ${MAX_ROLES_PER_EMPLOYEE} different positive integers`)
  }
  return [...value]
}

export function validateEmployeeId(value: unknown): number {
  const id = typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : value
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new GatewayError(400, 'invalid_employee_id', 'employeeId must be a positive integer')
  }
  return id
}

export function validateEmployeeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  const hasControl = [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  if (name.length < 1 || name.length > 80 || hasControl) {
    throw new GatewayError(400, 'invalid_name', 'name must be 1 to 80 characters without control characters')
  }
  return name
}

function validateLeaveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new GatewayError(400, 'invalid_leave_id', 'leaveId must be a positive integer')
  }
  return value
}

const dayNumber = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86_400_000

/** A first and a last day (both included): real calendar days, in order, at most 366 days. */
function validateDays(from: unknown, to: unknown): { from: string; to: string } {
  const real = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  if (!real(from) || !real(to)) throw new GatewayError(400, 'invalid_dates', 'from and to must be calendar days like 2026-10-12')
  if (to < from) throw new GatewayError(400, 'invalid_dates', 'to must not be before from')
  if (dayNumber(to) - dayNumber(from) + 1 > MAX_SPAN_DAYS) throw new GatewayError(400, 'invalid_dates', `a period is at most ${MAX_SPAN_DAYS} days`)
  return { from, to }
}

/** The note is optional plain text on one line. */
function validateNote(value: unknown): string {
  if (value === undefined || value === null) return ''
  const hasControl = typeof value === 'string' && [...value].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159) || char === '\u2028' || char === '\u2029')
  if (typeof value !== 'string' || value.length > MAX_NOTE || hasControl) {
    throw new GatewayError(400, 'invalid_note', `note must be text of at most ${MAX_NOTE} characters on one line`)
  }
  return value.trim()
}

const isDashboardLeave = (name: string) => name === UNAVAILABILITY_MARKER || name.startsWith(`${UNAVAILABILITY_MARKER}: `)

function amsterdamDate(ms: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date(ms))
}

export function createActions(options: { odoo: OdooClient; now: () => number }) {
  const { odoo, now } = options
  const entries = new Map<string, Entry>()
  const unavailabilityEntries = new Map<string, UnavailabilityEntry>()
  const documentEntries = new Map<string, DocumentEntry>()
  const attempts = new Map<string, number[]>()

  function remember(key: string, entry: Entry) {
    entries.set(key, entry)
    for (const [oldKey, old] of entries) {
      if (entries.size <= MAX_ENTRIES) break
      if (old.state !== 'pending') entries.delete(oldKey)
    }
  }

  function limitReached(key: string, perHour: number) {
    const recent = (attempts.get(key) ?? []).filter((time) => now() - time < HOUR_MS)
    attempts.set(key, recent)
    return recent.length >= perHour
  }

  function refuseRolesOutside(allowed: readonly number[] | null | undefined, roles: readonly number[]) {
    if (!allowed) return
    const outside = roles.filter((id) => !allowed.includes(id))
    if (outside.length > 0) throw new GatewayError(409, 'planning_role_not_allowed', `planning role ${outside.join(', ')} is not allowed for this project`)
  }

  async function refuseRolesGone(roles: readonly number[], companyId: number) {
    if (roles.length === 0) return
    const found = await odoo.checkPlanningRoles({ ids: roles, companyId })
    const missing = roles.filter((id) => !found.includes(id))
    if (missing.length > 0) throw new GatewayError(409, 'planning_role_not_allowed', `planning role ${missing.join(', ')} does not exist or is archived`)
  }

  return {
    /** What a planner can choose from: the active roles of Odoo, limited to the allowed ones when the project says so. */
    async listPlanningRoles(project: Project) {
      const policies = [project.actions.createEmployee, project.actions.setEmployeePlanningRoles].filter((policy) => policy !== undefined)
      if (policies.length === 0) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: createEmployee')
      const roles = await odoo.listPlanningRoles({ companyId: project.companyId })
      // When more than one action limits the roles, the strictest wins: a role must be allowed by every one of them.
      return { roles: roles.filter((role) => policies.every((policy) => policy.allowedPlanningRoleIds === null || policy.allowedPlanningRoleIds.includes(role.id))) }
    },

    /** The planning roles an employee has now (and his default), so that the planner starts from what Odoo says. */
    async employeePlanningRoles(project: Project, employeeId: unknown, ctx: ActionContext) {
      if (!project.actions.setEmployeePlanningRoles) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: setEmployeePlanningRoles')
      const id = validateEmployeeId(employeeId)
      ctx.employeeId = id
      const record = await odoo.readEmployee({ id, companyId: project.companyId, planningRoles: true })
      if (!record || !record.active) throw new GatewayError(404, 'employee_not_found', 'no active employee with this id in the company of the project')
      return { id, planningRoleIds: record.planningRoleIds ?? [], defaultPlanningRoleId: record.defaultPlanningRoleId }
    },

    /**
     * Sets the planning roles of ONE existing employee (the first is his default) and nothing else about him. Setting the same
     * roles twice gives the same employee, so no request id is needed: after an unclear answer the caller may simply repeat.
     */
    async setEmployeePlanningRoles(project: Project, body: Record<string, unknown>, ctx: ActionContext) {
      const policy = project.actions.setEmployeePlanningRoles
      if (!policy) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: setEmployeePlanningRoles')
      const extra = Object.keys(body).filter((key) => key !== 'employeeId' && key !== 'planningRoleIds')
      if (extra.length > 0) throw new GatewayError(400, 'unknown_parameter', `unknown parameter: ${extra[0]}`)
      const id = validateEmployeeId(body.employeeId)
      if (body.planningRoleIds === undefined) throw new GatewayError(400, 'invalid_planning_roles', 'planningRoleIds is required (an empty list takes the roles away)')
      const roles = validatePlanningRoleIds(body.planningRoleIds)
      ctx.employeeId = id
      refuseRolesOutside(policy.allowedPlanningRoleIds, roles)

      const record = await odoo.readEmployee({ id, companyId: project.companyId, planningRoles: true })
      if (!record || !record.active) throw new GatewayError(404, 'employee_not_found', 'no active employee with this id in the company of the project')
      await refuseRolesGone(roles, project.companyId)
      const key = `${project.id}:roles`
      if (limitReached(key, policy.maxPerHour)) throw new GatewayError(429, 'rate_limited', `at most ${policy.maxPerHour} changes per hour`)
      attempts.set(key, [...(attempts.get(key) ?? []), now()])

      try {
        await odoo.setEmployeePlanningRoles({ id, companyId: project.companyId, planningRoleIds: roles, defaultPlanningRoleId: roles[0] ?? null })
      } catch (error) {
        if (error instanceof OdooWriteError && error.outcome === 'rejected') throw new GatewayError(502, 'odoo_rejected', error.odooName ?? `upstream status ${error.status}`)
        throw new GatewayError(504, 'outcome_unknown', 'it is not known whether the roles were changed; read them again, or repeat the request (it sets the same roles)')
      }

      // Read back what Odoo has now: how many of the asked roles it confirms.
      let confirmed = 0
      try {
        const after = await odoo.readEmployee({ id, companyId: project.companyId, planningRoles: true })
        if (after?.planningRoleIds) confirmed = roles.filter((role) => after.planningRoleIds?.includes(role)).length
      } catch {
        // The roles were written (Odoo said so); only the check failed.
      }
      return { id, planningRoles: confirmed, asked: roles.length }
    },

    /** Marks ONE employee as not available in a period: one `resource.calendar.leaves`, no shift, no planning. */
    async addEmployeeUnavailability(project: Project, body: Record<string, unknown>, ctx: ActionContext) {
      const policy = project.actions.employeeUnavailability
      if (!policy) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: employeeUnavailability')
      const extra = Object.keys(body).filter((key) => !['requestId', 'employeeId', 'from', 'to', 'note'].includes(key))
      if (extra.length > 0) throw new GatewayError(400, 'unknown_parameter', `unknown parameter: ${extra[0]}`)
      const requestId = validateRequestId(body.requestId)
      const employeeId = validateEmployeeId(body.employeeId)
      const days = validateDays(body.from, body.to)
      const note = validateNote(body.note)
      ctx.requestId = requestId
      ctx.employeeId = employeeId
      const same = JSON.stringify([employeeId, days.from, days.to, note])

      const key = `${project.id}:away:${requestId}`
      const known = unavailabilityEntries.get(key)
      if (known && known.expires > now()) {
        if (known.same !== same) throw new GatewayError(409, 'request_id_reused', 'this requestId was used for another period, employee or note')
        if (known.state === 'pending') throw new GatewayError(409, 'in_progress', 'this request is still running')
        if (known.state === 'unknown') throw new GatewayError(409, 'outcome_unknown', 'it is not known whether the period was marked; look in Odoo')
        return { ...known.result, replayed: true }
      }

      const entry: UnavailabilityEntry = { same, state: 'pending', expires: now() + ENTRY_TTL_MS }
      unavailabilityEntries.set(key, entry)
      let attempted = false
      try {
        const employee = await odoo.readEmployee({ id: employeeId, companyId: project.companyId, resource: true })
        if (!employee || !employee.active || employee.companyId !== project.companyId) {
          throw new GatewayError(404, 'employee_not_found', 'no active employee with this id in the company of the project')
        }
        if (employee.resourceId === null) throw new GatewayError(409, 'employee_has_no_resource', 'the employee has no resource in Odoo, so he cannot be marked as not available')
        // The days are the days of the employee's own time zone; one that is not known is never guessed.
        if (!isTimeZone(employee.tz)) throw new GatewayError(409, 'employee_timezone_unknown', 'the employee has no known time zone in Odoo')
        const range = dayRangeInUtc(days.from, days.to, employee.tz)
        const name = note ? `${UNAVAILABILITY_MARKER}: ${note}` : UNAVAILABILITY_MARKER

        const bucket = `${project.id}:away`
        if (limitReached(bucket, policy.maxPerHour)) throw new GatewayError(429, 'rate_limited', `at most ${policy.maxPerHour} changes per hour`)
        attempts.set(bucket, [...(attempts.get(bucket) ?? []), now()])

        attempted = true
        let id: number
        try {
          id = await odoo.createUnavailability({ name, resourceId: employee.resourceId, calendarId: employee.resourceCalendarId, companyId: project.companyId, dateFrom: range.dateFrom, dateTo: range.dateTo })
        } catch (error) {
          if (error instanceof OdooWriteError && error.outcome === 'rejected') {
            unavailabilityEntries.delete(key)
            throw new GatewayError(502, 'odoo_rejected', error.odooName ?? `upstream status ${error.status}`)
          }
          entry.state = 'unknown'
          throw new GatewayError(504, 'outcome_unknown', 'it is not known whether the period was marked; look in Odoo')
        }

        // Read back what Odoo made: for this resource, with these days. A failing read-back does not undo the record.
        let verified = false
        try {
          const record = await odoo.readUnavailability({ id, companyId: project.companyId })
          verified = record !== null && record.resourceId === employee.resourceId && record.name === name && record.dateFrom === range.dateFrom && record.dateTo === range.dateTo
        } catch {
          // The record exists (Odoo gave its id); it is just not verified.
        }
        entry.state = 'done'
        entry.result = { id, employeeId, from: days.from, to: days.to, verified }
        return entry.result
      } catch (error) {
        if (!attempted) unavailabilityEntries.delete(key)
        throw error
      }
    },

    /** Removes ONE record that the dashboard marked for this employee; nothing else can be removed this way. */
    async removeEmployeeUnavailability(project: Project, body: Record<string, unknown>, ctx: ActionContext) {
      const policy = project.actions.employeeUnavailability
      if (!policy) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: employeeUnavailability')
      const extra = Object.keys(body).filter((key) => key !== 'employeeId' && key !== 'leaveId')
      if (extra.length > 0) throw new GatewayError(400, 'unknown_parameter', `unknown parameter: ${extra[0]}`)
      const employeeId = validateEmployeeId(body.employeeId)
      const leaveId = validateLeaveId(body.leaveId)
      ctx.employeeId = employeeId

      // An employee who has left (archived) can still have his record removed; one of another company cannot.
      const employee = await odoo.readEmployee({ id: employeeId, companyId: project.companyId, resource: true })
      if (!employee || employee.companyId !== project.companyId) {
        throw new GatewayError(404, 'employee_not_found', 'no employee with this id in the company of the project')
      }
      if (employee.resourceId === null) throw new GatewayError(409, 'employee_has_no_resource', 'the employee has no resource in Odoo')
      const record = await odoo.readUnavailability({ id: leaveId, companyId: project.companyId })
      if (!record) return { leaveId, removed: false, alreadyGone: true }
      if (record.resourceId !== employee.resourceId || !isDashboardLeave(record.name)) {
        throw new GatewayError(404, 'unavailability_not_found', 'no record that the dashboard made for this employee')
      }
      const bucket = `${project.id}:away`
      if (limitReached(bucket, policy.maxPerHour)) throw new GatewayError(429, 'rate_limited', `at most ${policy.maxPerHour} changes per hour`)
      attempts.set(bucket, [...(attempts.get(bucket) ?? []), now()])
      try {
        await odoo.removeUnavailability({ id: leaveId, companyId: project.companyId })
      } catch (error) {
        if (error instanceof OdooWriteError && error.outcome === 'rejected') throw new GatewayError(502, 'odoo_rejected', error.odooName ?? `upstream status ${error.status}`)
        throw new GatewayError(504, 'outcome_unknown', 'it is not known whether the record was removed; repeat the request (removing it again is harmless)')
      }
      return { leaveId, removed: true }
    },

    /**
     * Puts ONE signed PDF on the customer of an appointment: an attachment and an internal note without recipients (so no mail).
     * The customer is read from the planning.slot or svs.tech.visit that is named; the caller can not name a customer.
     */
    async postDocument(project: Project, body: Record<string, unknown>, ctx: ActionContext) {
      const policy = project.actions.postDocument
      if (!policy) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: postDocument')
      const extra = Object.keys(body).filter((key) => !['requestId', 'reference', 'filename', 'summary', 'pdf'].includes(key))
      if (extra.length > 0) throw new GatewayError(400, 'unknown_parameter', `unknown parameter: ${extra[0]}`)
      const requestId = validateRequestId(body.requestId)
      ctx.requestId = requestId

      const reference = body.reference as Record<string, unknown> | null | undefined
      if (
        !reference || typeof reference !== 'object' || Array.isArray(reference) || Object.keys(reference).some((key) => key !== 'model' && key !== 'id') ||
        !(DOCUMENT_REFERENCES as readonly unknown[]).includes(reference.model) || typeof reference.id !== 'number' || !Number.isInteger(reference.id) || reference.id <= 0 || reference.id > 2_147_483_647
      ) {
        throw new GatewayError(400, 'invalid_reference', 'reference must be {model: planning.slot or svs.tech.visit, id}')
      }
      const model = reference.model as string
      const id = reference.id
      if (typeof body.filename !== 'string' || !FILENAME.test(body.filename)) throw new GatewayError(400, 'invalid_filename', 'filename must be letters, digits, dot, dash or underscore and end in .pdf')
      const filename = body.filename
      const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
      if (summary.length < 1 || summary.length > 300 || [...summary].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        throw new GatewayError(400, 'invalid_summary', 'summary must be one line of 1 to 300 characters')
      }
      const pdf = body.pdf
      if (typeof pdf !== 'string' || pdf.length < 8 || pdf.length % 4 !== 0 || !BASE64.test(pdf)) throw new GatewayError(400, 'invalid_pdf', 'pdf must be base64')
      const bytes = (pdf.length / 4) * 3 - (pdf.endsWith('==') ? 2 : pdf.endsWith('=') ? 1 : 0)
      if (bytes > MAX_PDF_BYTES) throw new GatewayError(413, 'pdf_too_large', `a pdf is at most ${MAX_PDF_BYTES} bytes`)
      if (!Buffer.from(pdf.slice(0, 8), 'base64').toString('latin1').startsWith('%PDF-') || !Buffer.from(pdf.slice(-2048), 'base64').toString('latin1').includes('%%EOF')) {
        throw new GatewayError(400, 'invalid_pdf', 'the file is not a PDF')
      }
      const same = JSON.stringify([model, id, filename, summary, createHash('sha256').update(pdf).digest('hex')])

      const key = `${project.id}:doc:${requestId}`
      const known = documentEntries.get(key)
      if (known && known.expires > now()) {
        if (known.same !== same) throw new GatewayError(409, 'request_id_reused', 'this requestId was used for another document')
        if (known.state === 'pending') throw new GatewayError(409, 'in_progress', 'this request is still running')
        if (known.state === 'unknown') throw new GatewayError(409, 'outcome_unknown', 'it is not known whether the document was posted; look at the customer in Odoo')
        return { ...known.result, replayed: true }
      }

      const entry: DocumentEntry = { same, state: 'pending', expires: now() + ENTRY_TTL_MS }
      documentEntries.set(key, entry)
      let attempted = false
      try {
        const partner = await odoo.readReferencePartner({ model, id, companyId: project.companyId })
        if (!partner) throw new GatewayError(404, 'reference_not_found', 'no such record in the company of the project')
        if (partner.partnerId === null) throw new GatewayError(409, 'reference_has_no_customer', 'the record has no customer')

        const bucket = `${project.id}:docs`
        if (limitReached(bucket, policy.maxPerHour)) throw new GatewayError(429, 'rate_limited', `at most ${policy.maxPerHour} documents per hour`)
        attempts.set(bucket, [...(attempts.get(bucket) ?? []), now()])

        attempted = true
        let posted: { attachmentId: number; noted: boolean }
        try {
          posted = await odoo.postDocument({ partnerId: partner.partnerId, companyId: project.companyId, filename, pdfBase64: pdf, note: summary })
        } catch (error) {
          if (error instanceof OdooWriteError && error.outcome === 'rejected') {
            documentEntries.delete(key)
            throw new GatewayError(502, 'odoo_rejected', error.odooName ?? `upstream status ${error.status}`)
          }
          entry.state = 'unknown'
          throw new GatewayError(504, 'outcome_unknown', 'it is not known whether the document was posted; look at the customer in Odoo')
        }
        entry.state = 'done'
        entry.result = { id: posted.attachmentId, noted: posted.noted, customer: partner.partnerName }
        return entry.result
      } catch (error) {
        if (!attempted) documentEntries.delete(key)
        throw error
      }
    },

    async createEmployee(project: Project, body: Record<string, unknown>, ctx: ActionContext) {
      const policy = project.actions.createEmployee
      if (!policy) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: createEmployee')
      const extra = Object.keys(body).filter((key) => key !== 'requestId' && key !== 'name' && key !== 'planningRoleIds')
      if (extra.length > 0) throw new GatewayError(400, 'unknown_parameter', `unknown parameter: ${extra[0]}`)
      const requestId = validateRequestId(body.requestId)
      const name = validateEmployeeName(body.name)
      const roles = validatePlanningRoleIds(body.planningRoleIds)
      ctx.requestId = requestId
      // A project can limit the roles a planner may choose; refused before anything is asked or remembered.
      refuseRolesOutside(policy.allowedPlanningRoleIds, roles)

      const key = `${project.id}:${requestId}`
      const known = entries.get(key)
      if (known && known.expires > now()) {
        if (known.name !== name || known.roles.length !== roles.length || known.roles.some((id, index) => id !== roles[index])) {
          throw new GatewayError(409, 'request_id_reused', 'this requestId was used for another name or other roles')
        }
        if (known.state === 'pending') throw new GatewayError(409, 'in_progress', 'this request is still running')
        if (known.state === 'unknown') {
          throw new GatewayError(409, 'outcome_unknown', 'it is not known whether the employee was created; look in Odoo')
        }
        if (known.result) ctx.employeeId = known.result.id
        if (known.failure) throw known.failure
        return { ...known.result, replayed: true }
      }

      const entry: Entry = { name, roles, state: 'pending', expires: now() + ENTRY_TTL_MS }
      remember(key, entry)
      let attempted = false
      try {
        // The responsible is checked on every request: users get archived or leave the company.
        const check = await odoo.checkResponsible({ userId: policy.responsibleUserId, companyId: project.companyId })
        if (!check.exists || !check.active || !check.internal || !check.inCompany) {
          const why = !check.exists ? 'does not exist' : !check.active ? 'is not active' : !check.internal ? 'is not an internal user' : 'is not in the company'
          throw new GatewayError(409, 'responsible_not_allowed', `the configured responsible ${why}`)
        }
        // The chosen planning roles must exist and be active in Odoo.
        await refuseRolesGone(roles, project.companyId)
        if (limitReached(project.id, policy.maxPerHour)) {
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
            planningRoleIds: roles,
            // The first role the planner chose is the default one: Odoo then pre-selects it for a new shift.
            defaultPlanningRoleId: roles[0] ?? null,
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
        let planningRoles = 0
        const wantRoles = roles.length > 0
        try {
          const record = await odoo.readEmployee({ id, companyId: project.companyId, planningRoles: wantRoles })
          if (record && (record.userLinked || record.companyId !== project.companyId)) {
            entry.state = 'done'
            entry.failure = new GatewayError(500, 'employee_invariant_violated', 'the employee was created but is not as intended', { id })
            throw entry.failure
          }
          verified = record !== null
          // How many of the configured roles Odoo says the employee has: what the planner can count on in Planning.
          if (record && wantRoles && record.planningRoleIds) planningRoles = roles.filter((role) => record.planningRoleIds?.includes(role)).length
        } catch (error) {
          if (error instanceof GatewayError) throw error
          // Reading back failed: the employee was created (Odoo confirmed the id), it is just not verified.
        }
        entry.state = 'done'
        entry.result = { id, name, verified, planningRoles }
        return entry.result
      } catch (error) {
        if (!attempted) entries.delete(key)
        throw error
      }
    },
  }
}
