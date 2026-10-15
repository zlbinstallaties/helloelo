import type { IncomingMessage, ServerResponse } from 'node:http'
import { OdooError, type OdooClient, type OdooFieldInfo } from '../../src/lib/odoo-client.ts'
import { createActions } from './actions.ts'
import { validateDomain, validateFields, validateOrder } from './domain.ts'
import { GatewayError } from './errors.ts'
import { findProject, type Project, type ReadMethod } from './projects.ts'

/*
 * HTTP surface of the Odoo gateway.
 *
 *   GET  /healthz
 *   GET  /v1/schema                          allowlisted models and fields
 *   POST /v1/models/<model>/search_read      {fields?, domain?, limit?, offset?, order?}
 *   POST /v1/models/<model>/search_count     {domain?}
 *   GET  /v1/planning-roles                  the planning roles a planner can give a new employee (only for
 *                                            a project that has the createEmployee action)
 *   GET  /v1/employees/<id>/planning-roles   the planning roles one employee has now (only with setEmployeePlanningRoles)
 *   POST /v1/actions/set_employee_planning_roles  {employeeId, planningRoleIds}: the roles of ONE employee, nothing else
 *                                            (only with setEmployeePlanningRoles; off by default)
 *   POST /v1/actions/create_employee         {requestId, name, planningRoleIds?}: an hr.employee without an Odoo user,
 *                                            only for projects whose config has the action (off by default)
 *
 * Every /v1 call needs `Authorization: Bearer <project token>`. The project
 * decides company, models, fields and methods; the request cannot widen them.
 */

export interface AccessLogEntry {
  ts: string
  project: string | null
  route: string
  model: string | null
  status: number
  code: string | null
  ms: number
  rows?: number
  fields?: number
  domainFields?: string[]
  requestId?: string
  employeeId?: number
  /** For an error of Odoo: the class name Odoo gave (`odoo.exceptions.AccessDenied`) or its status; never Odoo's own text. */
  upstream?: string
}

export interface GatewayOptions {
  projects: readonly Project[]
  odoo: OdooClient
  log?: (entry: AccessLogEntry) => void
  schemaTtlMs?: number
  now?: () => number
}

const MAX_BODY_BYTES = 64 * 1024
const MODEL_ROUTE = /^\/v1\/models\/([a-z0-9_.]+)\/(search_read|search_count)$/
const CREATE_EMPLOYEE_ROUTE = '/v1/actions/create_employee'
const PLANNING_ROLES_ROUTE = '/v1/planning-roles'
const SET_ROLES_ROUTE = '/v1/actions/set_employee_planning_roles'
/** What may be logged of an error of Odoo: a class name like odoo.exceptions.AccessDenied, or `upstream status 401`. */
const PLAIN_UPSTREAM = /^(?:[A-Za-z_][\w.]{0,80}|upstream status \d{1,3})$/
/** A document is a PDF of up to 8 MiB, as base64 in JSON; the other routes stay at the small limit. */
const POST_DOCUMENT_ROUTE = '/v1/actions/post_document'
const DOCUMENT_BODY_BYTES = 12 * 1024 * 1024
const ADD_UNAVAILABILITY_ROUTE = '/v1/actions/add_employee_unavailability'
const REMOVE_UNAVAILABILITY_ROUTE = '/v1/actions/remove_employee_unavailability'
const EMPLOYEE_ROLES_ROUTE = /^\/v1\/employees\/([0-9]+)\/planning-roles$/
const SCHEMA_ATTRIBUTES = ['type', 'string', 'relation', 'required', 'readonly']

interface Context {
  project: Project | null
  model: string | null
  upstream?: string
  rows?: number
  fields?: number
  domainFields?: string[]
  requestId?: string
  employeeId?: number
}

function send(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? ''
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new GatewayError(415, 'unsupported_media_type', 'content-type must be application/json')
  }
  // A body that says it is too big is refused before a single byte of it is read.
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new GatewayError(413, 'body_too_large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new GatewayError(413, 'body_too_large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new GatewayError(400, 'invalid_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(400, 'invalid_json', 'body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key))
  if (extra.length > 0) throw new GatewayError(400, 'unknown_parameter', `unknown parameter: ${extra[0]}`)
}

function intParam(value: unknown, name: string, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new GatewayError(400, `invalid_${name}`, `${name} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

function authenticate(req: IncomingMessage, projects: readonly Project[]): Project {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer (\S+)$/i.exec(header)
  const project = match ? findProject(projects, match[1]) : null
  if (!project) throw new GatewayError(401, 'unauthorized')
  return project
}

function policyFor(project: Project, model: string, method: ReadMethod) {
  const policy = Object.hasOwn(project.models, model) ? project.models[model] : undefined
  if (!policy) throw new GatewayError(403, 'model_not_allowed', `model not allowed: ${model}`)
  if (!policy.methods.includes(method)) {
    throw new GatewayError(403, 'method_not_allowed', `method not allowed: ${method}`)
  }
  return policy
}

function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  if (error instanceof OdooError) {
    if (/timed out/.test(error.message)) return new GatewayError(504, 'odoo_timeout')
    // Odoo's own message can contain record data; expose only the class name.
    return new GatewayError(502, 'odoo_error', error.odooName ?? `upstream status ${error.status}`)
  }
  return new GatewayError(500, 'internal_error')
}

export function createGateway(options: GatewayOptions) {
  const { projects, odoo } = options
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)))
  const now = options.now ?? Date.now
  const schemaTtlMs = options.schemaTtlMs ?? 5 * 60_000
  const fieldCache = new Map<string, { at: number; fields: Record<string, OdooFieldInfo> }>()
  const actions = createActions({ odoo, now })

  async function modelFields(model: string) {
    const hit = fieldCache.get(model)
    if (hit && now() - hit.at < schemaTtlMs) return hit.fields
    const fields = await odoo.fieldsGet(model, SCHEMA_ATTRIBUTES)
    fieldCache.set(model, { at: now(), fields })
    return fields
  }

  async function schema(project: Project) {
    const models = []
    for (const [name, policy] of Object.entries(project.models)) {
      let odooFields: Record<string, OdooFieldInfo>
      try {
        odooFields = await modelFields(name)
      } catch (error) {
        // A model this database does not have (a custom module that is not installed): say so, so that one
        // unknown model does not hide the answer for the others. Any other error is still an error.
        if (error instanceof OdooError && error.answered && error.status === 404 && error.message.includes('does not exist')) {
          models.push({ name, methods: policy.methods, fields: [], missing: [...policy.fields], unknownModel: true })
          continue
        }
        throw error
      }
      models.push({
        name,
        methods: policy.methods,
        fields: policy.fields
          .filter((field) => Object.hasOwn(odooFields, field))
          .map((field) => {
            const info = odooFields[field]
            return {
              name: field,
              type: info.type,
              label: info.string ?? null,
              relation: info.relation ?? null,
              required: Boolean(info.required),
              readonly: Boolean(info.readonly),
            }
          }),
        // Allowlisted but unknown to this Odoo database: a config or version mismatch.
        missing: policy.fields.filter((field) => !Object.hasOwn(odooFields, field)),
      })
    }
    return { project: project.id, companyId: project.companyId, models }
  }

  async function route(req: IncomingMessage, url: URL, ctx: Context) {
    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') throw new GatewayError(405, 'method_not_allowed')
      return { status: 'ok' }
    }

    if (url.pathname === '/v1/schema') {
      if (req.method !== 'GET') throw new GatewayError(405, 'method_not_allowed')
      ctx.project = authenticate(req, projects)
      return schema(ctx.project)
    }

    if (url.pathname === PLANNING_ROLES_ROUTE) {
      if (req.method !== 'GET') throw new GatewayError(405, 'method_not_allowed')
      ctx.model = 'planning.role'
      ctx.project = authenticate(req, projects)
      return actions.listPlanningRoles(ctx.project)
    }

    const rolesMatch = EMPLOYEE_ROLES_ROUTE.exec(url.pathname)
    if (rolesMatch) {
      if (req.method !== 'GET') throw new GatewayError(405, 'method_not_allowed')
      ctx.model = 'hr.employee'
      ctx.project = authenticate(req, projects)
      return actions.employeePlanningRoles(ctx.project, rolesMatch[1], ctx)
    }

    if (url.pathname === SET_ROLES_ROUTE) {
      if (req.method !== 'POST') throw new GatewayError(405, 'method_not_allowed')
      ctx.model = 'hr.employee'
      ctx.project = authenticate(req, projects)
      // Not allowed for the project: refused before the body is even read.
      if (!ctx.project.actions.setEmployeePlanningRoles) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: setEmployeePlanningRoles')
      return actions.setEmployeePlanningRoles(ctx.project, await readJson(req), ctx)
    }

    if (url.pathname === ADD_UNAVAILABILITY_ROUTE || url.pathname === REMOVE_UNAVAILABILITY_ROUTE) {
      if (req.method !== 'POST') throw new GatewayError(405, 'method_not_allowed')
      ctx.model = 'resource.calendar.leaves'
      ctx.project = authenticate(req, projects)
      // Not allowed for the project: refused before the body is even read.
      if (!ctx.project.actions.employeeUnavailability) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: employeeUnavailability')
      const body = await readJson(req)
      return url.pathname === ADD_UNAVAILABILITY_ROUTE ? actions.addEmployeeUnavailability(ctx.project, body, ctx) : actions.removeEmployeeUnavailability(ctx.project, body, ctx)
    }

    if (url.pathname === POST_DOCUMENT_ROUTE) {
      if (req.method !== 'POST') throw new GatewayError(405, 'method_not_allowed')
      ctx.model = 'res.partner'
      ctx.project = authenticate(req, projects)
      // Not allowed for the project: refused before the body (up to 12 MB) is even read.
      if (!ctx.project.actions.postDocument) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: postDocument')
      return actions.postDocument(ctx.project, await readJson(req, DOCUMENT_BODY_BYTES), ctx)
    }

    if (url.pathname === CREATE_EMPLOYEE_ROUTE) {
      if (req.method !== 'POST') throw new GatewayError(405, 'method_not_allowed')
      ctx.model = 'hr.employee'
      ctx.project = authenticate(req, projects)
      // Not allowed for the project: refused before the body is even read.
      if (!ctx.project.actions.createEmployee) throw new GatewayError(403, 'action_not_allowed', 'action not allowed: createEmployee')
      return actions.createEmployee(ctx.project, await readJson(req), ctx)
    }

    const match = MODEL_ROUTE.exec(url.pathname)
    if (!match) throw new GatewayError(404, 'not_found')
    if (req.method !== 'POST') throw new GatewayError(405, 'method_not_allowed')
    const [, model, method] = match as unknown as [string, string, ReadMethod]
    ctx.model = model
    ctx.project = authenticate(req, projects)
    const project = ctx.project
    const policy = policyFor(project, model, method)
    const body = await readJson(req)

    if (method === 'search_count') {
      rejectUnknownKeys(body, ['domain'])
      ctx.domainFields = validateDomain(body.domain, policy.fields)
      const count = await odoo.searchCount({
        model,
        companyId: project.companyId,
        domain: body.domain as unknown[] | undefined,
      })
      return { count }
    }

    rejectUnknownKeys(body, ['fields', 'domain', 'limit', 'offset', 'order'])
    const fields = validateFields(body.fields, policy.fields)
    ctx.fields = fields.length
    ctx.domainFields = validateDomain(body.domain, policy.fields)
    const order = validateOrder(body.order, policy.fields)
    const limit = intParam(body.limit, 'limit', project.maxLimit, 1, project.maxLimit)
    const offset = intParam(body.offset, 'offset', 0, 0, 1_000_000)
    const records = await odoo.searchRead({
      model,
      fields,
      companyId: project.companyId,
      domain: body.domain as unknown[] | undefined,
      limit,
      offset,
      order,
    })
    ctx.rows = records.length
    return { records, count: records.length, limit, offset }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = now()
    const url = new URL(req.url ?? '/', 'http://gateway.local')
    const ctx: Context = { project: null, model: null }
    let status = 200
    let code: string | null = null
    try {
      const payload = await route(req, url, ctx)
      send(res, 200, payload)
    } catch (error) {
      const failure = toGatewayError(error)
      status = failure.status
      code = failure.code
      // Which kind of error Odoo gave helps to find a wrong key or a missing right; only a plain class name is logged.
      if (failure.code === 'odoo_error' && PLAIN_UPSTREAM.test(failure.message)) ctx.upstream = failure.message
      send(res, status, { error: failure.code, message: failure.message, ...(failure.details && { details: failure.details }) })
    } finally {
      if (url.pathname !== '/healthz') {
        log({
          ts: new Date(started).toISOString(),
          project: ctx.project?.id ?? null,
          route: `${req.method} ${url.pathname}`,
          model: ctx.model,
          status,
          code,
          ms: now() - started,
          ...(ctx.rows !== undefined && { rows: ctx.rows }),
          ...(ctx.fields !== undefined && { fields: ctx.fields }),
          ...(ctx.domainFields && { domainFields: ctx.domainFields }),
          ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
          ...(ctx.employeeId !== undefined && { employeeId: ctx.employeeId }),
          ...(ctx.upstream !== undefined && { upstream: ctx.upstream }),
        })
      }
    }
  }
}
