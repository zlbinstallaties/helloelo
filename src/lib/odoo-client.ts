/*
 * Standalone Odoo client (External JSON-2 API, Odoo 19+).
 *
 * No platform imports on purpose: this file can run in Node or a test.
 * Config and secrets are injected by the caller (`gateway/src/main.ts`).
 *
 * Safety properties:
 *  - The generic methods are read-only (`search_read`, `search_count`,
 *    `fields_get`). There is no generic create / write / unlink / call.
 *  - Models of the generic methods are checked against an allowlist given at
 *    construction time. `hr.employee` and `res.users` are not on it.
 *  - A company filter is always added to the domain and to the context.
 *  - The API key is sent only in the Authorization header and never ends up
 *    in error messages.
 *
 * The one write is `createEmployee`: it creates a technician as an `hr.employee`
 * WITHOUT an Odoo user (`user_id` is always false) from a fixed set of values.
 * It cannot take another model, another field or another value for `user_id`.
 * Next to it two fixed reads: `checkResponsible` (is this Odoo user a valid
 * responsible for the company) and `readEmployee` (read back what was created).
 */

export interface OdooClientConfig {
  /** e.g. https://mijnbedrijf.odoo.com (no trailing path). */
  baseUrl: string
  /** Odoo API key of a dedicated user with minimal read rights. */
  apiKey: string
  /** X-Odoo-Database; needed when the server hosts several databases. */
  database?: string
  /** Models this client may read. Anything else is refused. */
  allowedModels: readonly string[]
  timeoutMs?: number
  /** Injectable for tests. */
  fetch?: typeof fetch
}

export interface SearchReadParams {
  model: string
  fields: string[]
  /** Extra domain; the company filter is always added on top. */
  domain?: unknown[]
  companyId: number
  limit?: number
  offset?: number
  order?: string
}

export interface SearchCountParams {
  model: string
  /** Extra domain; the company filter is always added on top. */
  domain?: unknown[]
  companyId: number
}

export interface OdooFieldInfo {
  type: string
  string?: string
  relation?: string
  required?: boolean
  readonly?: boolean
  [key: string]: unknown
}

export interface CreateEmployeeParams {
  /** Display name of the technician. */
  name: string
  companyId: number
  /** The Odoo user who is responsible for the employee (`hr_responsible_id`). Never the technician. */
  responsibleUserId: number
  /** Start date of the first version of the employee, `YYYY-MM-DD`. */
  dateVersion: string
  /** `planning.role` ids the employee gets (`planning_role_ids`); empty or absent: none. */
  planningRoleIds?: readonly number[]
  /** One of `planningRoleIds` (`default_planning_role_id`). */
  defaultPlanningRoleId?: number | null
}

/** Whether an Odoo user may be the responsible of an employee of a company. */
export interface ResponsibleCheck {
  exists: boolean
  active: boolean
  /** An internal user, not a portal or public one. */
  internal: boolean
  inCompany: boolean
}

export interface EmployeeRecord {
  id: number
  name: string
  companyId: number | null
  /** `planning_role_ids`; null when they were not asked for. */
  planningRoleIds: number[] | null
  /** `default_planning_role_id`; null when it was not asked for or is empty. */
  defaultPlanningRoleId: number | null
  /** The Odoo user linked to the employee, when Odoo gave its id in a shape we understand. */
  userId: number | null
  /**
   * True unless Odoo said `user_id` is empty (`false`). Also true when a user is linked but its id could not be read,
   * so an unexpected answer never counts as "no Odoo login".
   */
  userLinked: boolean
  active: boolean
}

export interface OdooClient {
  searchRead<T = Record<string, unknown>>(params: SearchReadParams): Promise<T[]>
  searchCount(params: SearchCountParams): Promise<number>
  /** Field definitions of an allowed model; contains no records. */
  fieldsGet(model: string, attributes?: string[]): Promise<Record<string, OdooFieldInfo>>
  /** Creates one `hr.employee` without an Odoo user and returns the id Odoo confirms. Throws `OdooWriteError`. */
  createEmployee(params: CreateEmployeeParams): Promise<number>
  checkResponsible(params: { userId: number; companyId: number }): Promise<ResponsibleCheck>
  /** Which of these `planning.role` ids exist and are active. */
  checkPlanningRoles(params: { ids: readonly number[]; companyId: number }): Promise<number[]>
  /** The active planning roles (`planning.role`), by name: what a planner can give a new employee. */
  listPlanningRoles(params: { companyId: number }): Promise<Array<{ id: number; name: string }>>
  /** Replaces the planning roles of one employee (`write` of `planning_role_ids` and `default_planning_role_id` only). Throws `OdooWriteError`. */
  setEmployeePlanningRoles(params: { id: number; companyId: number; planningRoleIds: readonly number[]; defaultPlanningRoleId?: number | null }): Promise<void>
  /** `planningRoles: true` also reads `planning_role_ids` and `default_planning_role_id` (the Planning module must be installed). */
  readEmployee(params: { id: number; companyId: number; planningRoles?: boolean }): Promise<EmployeeRecord | null>
}

export class OdooError extends Error {
  status: number
  odooName: string | null
  /** Odoo itself answered with an error (as opposed to no or an unusable answer). */
  answered: boolean

  constructor(message: string, status: number, odooName: string | null = null, answered = false) {
    super(message)
    this.name = 'OdooError'
    this.status = status
    this.odooName = odooName
    this.answered = answered
  }
}

/**
 * A failed write. `rejected`: Odoo answered with an error, so nothing was created and trying again is safe.
 * `unknown`: no usable answer (network, time-out, a proxy error, an odd reply): the record may exist, so
 * trying again could create a second one.
 */
export class OdooWriteError extends OdooError {
  outcome: 'rejected' | 'unknown'

  constructor(message: string, status: number, outcome: 'rejected' | 'unknown', odooName: string | null = null) {
    super(message, status, odooName, outcome === 'rejected')
    this.name = 'OdooWriteError'
    this.outcome = outcome
  }
}

const MODEL_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const FIELD_PATTERN = /^[a-z_][a-z0-9_]*$/
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 500
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_FIELD_ATTRIBUTES = ['type', 'string', 'relation', 'required', 'readonly']

function normalizeBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OdooError('ODOO_BASE_URL is not a valid URL', 0)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new OdooError('ODOO_BASE_URL must use https', 0)
  }
  return url.origin
}

export function createOdooClient(config: OdooClientConfig): OdooClient {
  if (!config.apiKey) throw new OdooError('Odoo API key is missing', 0)
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const allowed = new Set(config.allowedModels)
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  function checkModel(model: string) {
    if (!MODEL_PATTERN.test(model) || !allowed.has(model)) {
      throw new OdooError(`Model not allowed: ${model}`, 0)
    }
  }

  function checkCompany(companyId: number) {
    if (!Number.isInteger(companyId) || companyId <= 0) {
      throw new OdooError('companyId is required', 0)
    }
  }

  async function call(model: string, method: string, body: Record<string, unknown>, verb = 'read'): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `bearer ${config.apiKey}`,
    }
    if (config.database) headers['X-Odoo-Database'] = config.database

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await doFetch(`${baseUrl}/json/2/${model}/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError'
      throw new OdooError(
        timedOut ? `Odoo ${model} ${verb} timed out` : `Odoo ${model} ${verb} failed (network)`,
        0,
      )
    } finally {
      clearTimeout(timer)
    }

    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      // handled below
    }

    if (!response.ok) {
      const info = (payload && typeof payload === 'object' ? payload : {}) as {
        name?: unknown
        message?: unknown
      }
      const odooName = typeof info.name === 'string' ? info.name : null
      const message = typeof info.message === 'string' ? info.message.slice(0, 200) : ''
      throw new OdooError(
        `Odoo ${model} ${verb} failed (${response.status})${message ? `: ${message}` : ''}`,
        response.status,
        odooName,
        odooName !== null,
      )
    }
    return payload
  }

  async function searchRead<T>(params: SearchReadParams): Promise<T[]> {
    const { model } = params
    checkModel(model)
    checkCompany(params.companyId)
    if (params.fields.length === 0 || !params.fields.every((f) => FIELD_PATTERN.test(f))) {
      throw new OdooError('Invalid field list', 0)
    }
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = Math.max(params.offset ?? 0, 0)

    const body: Record<string, unknown> = {
      domain: [['company_id', '=', params.companyId], ...(params.domain ?? [])],
      fields: params.fields,
      limit,
      offset,
      context: { allowed_company_ids: [params.companyId] },
    }
    if (params.order) body.order = params.order

    const payload = await call(model, 'search_read', body)
    if (!Array.isArray(payload)) {
      throw new OdooError(`Odoo ${model} returned an unexpected response`, 200)
    }
    return payload as T[]
  }

  async function searchCount(params: SearchCountParams): Promise<number> {
    const { model } = params
    checkModel(model)
    checkCompany(params.companyId)
    const payload = await call(model, 'search_count', {
      domain: [['company_id', '=', params.companyId], ...(params.domain ?? [])],
      context: { allowed_company_ids: [params.companyId] },
    })
    if (typeof payload !== 'number' || !Number.isInteger(payload)) {
      throw new OdooError(`Odoo ${model} returned an unexpected response`, 200)
    }
    return payload
  }

  async function fieldsGet(model: string, attributes = DEFAULT_FIELD_ATTRIBUTES) {
    checkModel(model)
    if (!attributes.every((a) => FIELD_PATTERN.test(a))) {
      throw new OdooError('Invalid attribute list', 0)
    }
    const payload = await call(model, 'fields_get', { attributes })
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new OdooError(`Odoo ${model} returned an unexpected response`, 200)
    }
    return payload as Record<string, OdooFieldInfo>
  }

  const isId = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0
  /** The id of a related record: Odoo 20 sends `[id, display_name]` for a many2one; a bare id or `{id}` is accepted too. */
  const relatedId = (value: unknown): number | null => {
    if (isId(value)) return value
    if (Array.isArray(value)) return isId(value[0]) ? value[0] : null
    if (value && typeof value === 'object' && isId((value as { id?: unknown }).id)) return (value as { id: number }).id
    return null
  }
  const hasControlCharacter = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

  function validDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  }

  /** `rejected` only when Odoo itself answered with an error; every other failure leaves the outcome open. */
  function toWriteError(error: unknown): OdooWriteError {
    if (error instanceof OdooWriteError) return error
    if (error instanceof OdooError) {
      const definite = error.answered && ((error.status >= 400 && error.status < 500) || error.status === 500)
      return new OdooWriteError(error.message, error.status, definite ? 'rejected' : 'unknown', error.odooName)
    }
    return new OdooWriteError('Odoo hr.employee write failed', 0, 'unknown')
  }

  async function createEmployee(params: CreateEmployeeParams): Promise<number> {
    // Only these four values are read; anything else in `params` is ignored, `user_id` is never taken from it.
    const name = typeof params?.name === 'string' ? params.name.trim() : ''
    if (name.length < 1 || name.length > 80 || hasControlCharacter(name)) {
      throw new OdooWriteError('Invalid employee name', 0, 'rejected')
    }
    if (!isId(params.companyId)) throw new OdooWriteError('companyId is required', 0, 'rejected')
    if (!isId(params.responsibleUserId)) throw new OdooWriteError('responsibleUserId is required', 0, 'rejected')
    if (!validDate(params.dateVersion)) throw new OdooWriteError('Invalid dateVersion', 0, 'rejected')

    const roles = params.planningRoleIds ?? []
    if (!Array.isArray(roles) || roles.length > 5 || roles.some((id) => !isId(id)) || new Set(roles).size !== roles.length) {
      throw new OdooWriteError('Invalid planningRoleIds', 0, 'rejected')
    }
    const defaultRole = params.defaultPlanningRoleId ?? null
    if (defaultRole !== null && (!isId(defaultRole) || !roles.includes(defaultRole))) {
      throw new OdooWriteError('Invalid defaultPlanningRoleId', 0, 'rejected')
    }
    const vals: Record<string, unknown> = {
      name,
      company_id: params.companyId,
      hr_responsible_id: params.responsibleUserId,
      user_id: false,
      date_version: params.dateVersion,
    }
    // Planning roles are set only when the configuration says so; never from a request.
    if (roles.length > 0) vals.planning_role_ids = [[6, 0, [...roles]]]
    if (defaultRole !== null) vals.default_planning_role_id = defaultRole
    let payload: unknown
    try {
      payload = await call(
        'hr.employee',
        'create',
        {
          vals_list: [vals],
          // No chatter followers or mails because of this create.
          context: { allowed_company_ids: [params.companyId], mail_create_nosubscribe: true, mail_auto_subscribe_no_notify: true },
        },
        'write',
      )
    } catch (error) {
      throw toWriteError(error)
    }
    const id = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload
    if (!isId(id)) throw new OdooWriteError('Odoo hr.employee returned an unexpected response', 200, 'unknown')
    return id
  }

  async function checkResponsible(params: { userId: number; companyId: number }): Promise<ResponsibleCheck> {
    if (!isId(params?.userId)) throw new OdooError('userId is required', 0)
    checkCompany(params.companyId)
    const payload = await call('res.users', 'search_read', {
      domain: [['id', '=', params.userId]],
      fields: ['id', 'active', 'share', 'company_ids'],
      limit: 1,
      // Inactive users are found too, so that they can be reported as inactive.
      context: { allowed_company_ids: [params.companyId], active_test: false },
    })
    if (!Array.isArray(payload)) throw new OdooError('Odoo res.users returned an unexpected response', 200)
    const row = (payload as Array<Record<string, unknown>>).find((item) => item?.id === params.userId)
    if (!row) return { exists: false, active: false, internal: false, inCompany: false }
    return {
      exists: true,
      active: row.active === true,
      internal: row.share === false,
      // `company_ids` is a many2many: Odoo 20 sends a list of ids; a list of `[id, name]` pairs is accepted too.
      inCompany: Array.isArray(row.company_ids) && row.company_ids.some((item) => relatedId(item) === params.companyId),
    }
  }

  async function setEmployeePlanningRoles(params: { id: number; companyId: number; planningRoleIds: readonly number[]; defaultPlanningRoleId?: number | null }): Promise<void> {
    // Only these four values are read from `params`: the one employee, the company and the roles. Nothing else is written.
    if (!isId(params?.id)) throw new OdooWriteError('id is required', 0, 'rejected')
    if (!isId(params.companyId)) throw new OdooWriteError('companyId is required', 0, 'rejected')
    const roles = params.planningRoleIds
    if (!Array.isArray(roles) || roles.length > 5 || roles.some((id) => !isId(id)) || new Set(roles).size !== roles.length) {
      throw new OdooWriteError('Invalid planningRoleIds', 0, 'rejected')
    }
    const defaultRole = params.defaultPlanningRoleId ?? null
    if (defaultRole !== null && (!isId(defaultRole) || !roles.includes(defaultRole))) {
      throw new OdooWriteError('Invalid defaultPlanningRoleId', 0, 'rejected')
    }
    let payload: unknown
    try {
      payload = await call(
        'hr.employee',
        'write',
        {
          ids: [params.id],
          vals: { planning_role_ids: [[6, 0, [...roles]]], default_planning_role_id: defaultRole ?? false },
          context: { allowed_company_ids: [params.companyId], mail_create_nosubscribe: true, mail_auto_subscribe_no_notify: true },
        },
        'write',
      )
    } catch (error) {
      throw toWriteError(error)
    }
    // Odoo answers `true`; anything else is not a usable answer: the outcome is open (a repeat is safe: it sets the same roles).
    if (payload !== true) throw new OdooWriteError('Odoo hr.employee returned an unexpected response', 200, 'unknown')
  }

  async function checkPlanningRoles(params: { ids: readonly number[]; companyId: number }): Promise<number[]> {
    if (!Array.isArray(params?.ids) || params.ids.length === 0 || params.ids.length > 5 || params.ids.some((id) => !isId(id))) {
      throw new OdooError('ids must be 1 to 5 positive integers', 0)
    }
    checkCompany(params.companyId)
    const payload = await call('planning.role', 'search_read', {
      domain: [['id', 'in', [...params.ids]]],
      fields: ['id'],
      limit: 5,
      context: { allowed_company_ids: [params.companyId] },
    })
    if (!Array.isArray(payload)) throw new OdooError('Odoo planning.role returned an unexpected response', 200)
    return (payload as Array<Record<string, unknown>>).map((row) => row?.id).filter((id): id is number => isId(id) && params.ids.includes(id))
  }

  async function listPlanningRoles(params: { companyId: number }): Promise<Array<{ id: number; name: string }>> {
    checkCompany(params.companyId)
    const payload = await call('planning.role', 'search_read', {
      domain: [],
      fields: ['id', 'name'],
      order: 'name, id',
      limit: 200,
      context: { allowed_company_ids: [params.companyId] },
    })
    if (!Array.isArray(payload)) throw new OdooError('Odoo planning.role returned an unexpected response', 200)
    return (payload as Array<Record<string, unknown>>)
      .filter((row) => isId(row?.id) && typeof row.name === 'string' && row.name.trim() !== '')
      .map((row) => ({ id: row.id as number, name: (row.name as string).slice(0, 80) }))
  }

  async function readEmployee(params: { id: number; companyId: number; planningRoles?: boolean }): Promise<EmployeeRecord | null> {
    if (!isId(params?.id)) throw new OdooError('id is required', 0)
    checkCompany(params.companyId)
    const payload = await call('hr.employee', 'search_read', {
      // No company in the domain: an employee in another company must show up as such, not as "not found".
      domain: [['id', '=', params.id]],
      fields: params.planningRoles === true ? ['id', 'name', 'company_id', 'user_id', 'active', 'planning_role_ids', 'default_planning_role_id'] : ['id', 'name', 'company_id', 'user_id', 'active'],
      limit: 1,
      context: { allowed_company_ids: [params.companyId], active_test: false },
    })
    if (!Array.isArray(payload)) throw new OdooError('Odoo hr.employee returned an unexpected response', 200)
    const row = (payload as Array<Record<string, unknown>>).find((item) => item?.id === params.id)
    if (!row) return null
    return {
      id: params.id,
      name: typeof row.name === 'string' ? row.name : '',
      companyId: relatedId(row.company_id),
      // A many2many comes as a list of ids; only ids are kept, anything else is ignored.
      planningRoleIds: params.planningRoles === true ? (Array.isArray(row.planning_role_ids) ? row.planning_role_ids.map(relatedId).filter((id): id is number => id !== null) : []) : null,
      defaultPlanningRoleId: params.planningRoles === true ? relatedId(row.default_planning_role_id) : null,
      userId: relatedId(row.user_id),
      // Only an explicit empty value means "no Odoo login"; a missing field or an odd shape counts as linked.
      userLinked: row.user_id !== false && row.user_id !== null,
      active: row.active === true,
    }
  }

  return { searchRead, searchCount, fieldsGet, createEmployee, setEmployeePlanningRoles, checkResponsible, checkPlanningRoles, listPlanningRoles, readEmployee }
}
