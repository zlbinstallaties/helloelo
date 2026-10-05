import { createHash, timingSafeEqual } from 'node:crypto'
import { GatewayError } from './errors.ts'

/*
 * Per-project allowlist. A project is one generated app; it gets its own
 * gateway token and never sees the Odoo API key.
 *
 * Phase 1 is read-only: only the methods in READ_METHODS can be configured.
 * Write methods are refused when the config is loaded, not at request time.
 */

export const READ_METHODS = ['search_read', 'search_count'] as const
export type ReadMethod = (typeof READ_METHODS)[number]

export interface ModelPolicy {
  fields: readonly string[]
  methods: readonly ReadMethod[]
}

export interface Project {
  id: string
  companyId: number
  maxLimit: number
  models: Readonly<Record<string, ModelPolicy>>
  tokenSha256: Buffer
}

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
