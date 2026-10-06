import { createHash, timingSafeEqual } from 'node:crypto'
import { GatewayError } from './errors.ts'

/*
 * Per-project allowlist. A project is one generated app; it gets its own
 * gateway token and never sees the Odoo API key.
 *
 * Models are read-only: only the methods in READ_METHODS can be configured.
 * Write methods are refused when the config is loaded, not at request time.
 *
 * The only thing a project can do besides reading is a named, fixed action from
 * ACTIONS (see `actions` below). There is no generic create / write / unlink.
 * A project has no actions unless its config lists them, so every action is off
 * by default. Give actions to a dedicated project (and token) only, never to the
 * project of a preview or an agent.
 */

export const READ_METHODS = ['search_read', 'search_count'] as const
export type ReadMethod = (typeof READ_METHODS)[number]

export interface ModelPolicy {
  fields: readonly string[]
  methods: readonly ReadMethod[]
}

/**
 * Creating a technician as an Odoo employee without an Odoo user. The Odoo user who is responsible for the
 * employee is fixed here; a request can never choose it.
 */
export interface CreateEmployeePolicy {
  responsibleUserId: number
  /** Planning roles (`planning.role` ids) every new employee gets: a shift with a role can only go to someone who has it. */
  planningRoleIds: readonly number[]
  /** One of `planningRoleIds`; Odoo pre-selects it when a shift is made for the employee. */
  defaultPlanningRoleId: number | null
  /** At most this many creations per hour for the project, as a brake on a runaway client. */
  maxPerHour: number
}

export interface ProjectActions {
  createEmployee?: CreateEmployeePolicy
}

export interface Project {
  id: string
  companyId: number
  maxLimit: number
  models: Readonly<Record<string, ModelPolicy>>
  actions: Readonly<ProjectActions>
  tokenSha256: Buffer
}

export const ACTIONS = ['createEmployee'] as const
const DEFAULT_MAX_PER_HOUR = 20
const HARD_MAX_PER_HOUR = 200
const MAX_PLANNING_ROLES = 5

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/
const MODEL_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const FIELD_PATTERN = /^[a-z_][a-z0-9_]*$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const DEFAULT_MAX_LIMIT = 500
const HARD_MAX_LIMIT = 1000

function fail(message: string): never {
  throw new GatewayError(500, 'invalid_project_config', message)
}

function parseModel(projectId: string, model: string, raw: unknown): ModelPolicy {
  if (!MODEL_PATTERN.test(model)) fail(`${projectId}: invalid model name ${model}`)
  const policy = raw as { fields?: unknown; methods?: unknown }
  if (!policy || typeof policy !== 'object') fail(`${projectId}/${model}: policy must be an object`)
  if (!Array.isArray(policy.fields) || policy.fields.length === 0) {
    fail(`${projectId}/${model}: fields must be a non-empty list`)
  }
  for (const field of policy.fields) {
    if (typeof field !== 'string' || !FIELD_PATTERN.test(field) || field.includes('.')) {
      fail(`${projectId}/${model}: invalid field ${String(field)}`)
    }
  }
  if (!Array.isArray(policy.methods) || policy.methods.length === 0) {
    fail(`${projectId}/${model}: methods must be a non-empty list`)
  }
  for (const method of policy.methods) {
    if (!(READ_METHODS as readonly unknown[]).includes(method)) {
      fail(`${projectId}/${model}: method ${String(method)} is not allowed (read-only gateway)`)
    }
  }
  const fields = [...new Set(['id', ...(policy.fields as string[])])]
  return { fields, methods: [...new Set(policy.methods as ReadMethod[])] }
}

function parseActions(projectId: string, raw: unknown): ProjectActions {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${projectId}: actions must be an object`)
  const actions = raw as Record<string, unknown>
  for (const name of Object.keys(actions)) {
    if (!(ACTIONS as readonly string[]).includes(name)) fail(`${projectId}: action ${name} is not allowed`)
  }
  if (actions.createEmployee === undefined) return {}
  const entry = actions.createEmployee as Record<string, unknown> | null
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`${projectId}: createEmployee must be an object with responsibleUserId`)
  }
  for (const key of Object.keys(entry)) {
    if (!['responsibleUserId', 'maxPerHour', 'planningRoleIds', 'defaultPlanningRoleId'].includes(key)) {
      fail(`${projectId}: createEmployee has an unknown setting ${key}`)
    }
  }
  if (!Number.isInteger(entry.responsibleUserId) || (entry.responsibleUserId as number) <= 0) {
    fail(`${projectId}: createEmployee.responsibleUserId must be a positive integer`)
  }
  const maxPerHour = entry.maxPerHour ?? DEFAULT_MAX_PER_HOUR
  if (!Number.isInteger(maxPerHour) || (maxPerHour as number) < 1 || (maxPerHour as number) > HARD_MAX_PER_HOUR) {
    fail(`${projectId}: createEmployee.maxPerHour must be between 1 and ${HARD_MAX_PER_HOUR}`)
  }
  const roles = entry.planningRoleIds ?? []
  if (!Array.isArray(roles) || roles.length > MAX_PLANNING_ROLES || roles.some((id) => !Number.isInteger(id) || id <= 0) || new Set(roles).size !== roles.length) {
    fail(`${projectId}: createEmployee.planningRoleIds must be a list of at most ${MAX_PLANNING_ROLES} different positive integers`)
  }
  const defaultRole = entry.defaultPlanningRoleId ?? null
  if (defaultRole !== null && (!Number.isInteger(defaultRole) || !roles.includes(defaultRole))) {
    fail(`${projectId}: createEmployee.defaultPlanningRoleId must be one of planningRoleIds`)
  }
  return {
    createEmployee: {
      responsibleUserId: entry.responsibleUserId as number,
      maxPerHour: maxPerHour as number,
      planningRoleIds: roles as number[],
      defaultPlanningRoleId: defaultRole as number | null,
    },
  }
}

export function parseProjects(raw: unknown): Project[] {
  const root = raw as { projects?: unknown }
  if (!root || typeof root !== 'object' || !Array.isArray(root.projects)) {
    fail('config must be {"projects": [...]}')
  }
  const projects: Project[] = []
  const ids = new Set<string>()
  const hashes = new Set<string>()
  for (const entry of root.projects as unknown[]) {
    const p = entry as Record<string, unknown>
    if (!p || typeof p !== 'object') fail('project must be an object')
    const id = p.id
    if (typeof id !== 'string' || !PROJECT_ID_PATTERN.test(id)) fail(`invalid project id ${String(id)}`)
    if (ids.has(id)) fail(`duplicate project id ${id}`)
    ids.add(id)
    if (typeof p.tokenSha256 !== 'string' || !SHA256_PATTERN.test(p.tokenSha256)) {
      fail(`${id}: tokenSha256 must be a lowercase sha256 hex digest`)
    }
    if (hashes.has(p.tokenSha256)) fail(`${id}: token is shared with another project`)
    hashes.add(p.tokenSha256)
    if (!Number.isInteger(p.companyId) || (p.companyId as number) <= 0) fail(`${id}: companyId is required`)
    const maxLimit = p.maxLimit ?? DEFAULT_MAX_LIMIT
    if (!Number.isInteger(maxLimit) || (maxLimit as number) < 1 || (maxLimit as number) > HARD_MAX_LIMIT) {
      fail(`${id}: maxLimit must be between 1 and ${HARD_MAX_LIMIT}`)
    }
    const rawModels = p.models as Record<string, unknown> | undefined
    if (!rawModels || typeof rawModels !== 'object' || Object.keys(rawModels).length === 0) {
      fail(`${id}: models must be a non-empty object`)
    }
    const models: Record<string, ModelPolicy> = {}
    for (const [model, policy] of Object.entries(rawModels)) {
      models[model] = parseModel(id, model, policy)
    }
    projects.push({
      id,
      companyId: p.companyId as number,
      maxLimit: maxLimit as number,
      models,
      actions: parseActions(id, p.actions),
      tokenSha256: Buffer.from(p.tokenSha256, 'hex'),
    })
  }
  return projects
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Finds the project for a bearer token. Compares digests in constant time. */
export function findProject(projects: readonly Project[], token: string): Project | null {
  if (!token) return null
  const digest = createHash('sha256').update(token, 'utf8').digest()
  let match: Project | null = null
  for (const project of projects) {
    if (timingSafeEqual(digest, project.tokenSha256)) match = project
  }
  return match
}

/** Union of all configured models, used as the Odoo client allowlist. */
export function allModels(projects: readonly Project[]): string[] {
  return [...new Set(projects.flatMap((p) => Object.keys(p.models)))]
}
