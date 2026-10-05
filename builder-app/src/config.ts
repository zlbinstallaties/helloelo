import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

/*
 * Projects the builder app may change. Each project is a local git checkout of one app.
 *
 *   { "projects": [ {
 *       "id": "dashboard", "name": "Monteursdashboard",
 *       "workdir": "/srv/dig-builder/apps/dashboard",
 *       "baseBranch": "master",
 *       "sandbox": true,
 *       "gatewayUrl": "http://odoo-gateway:8070", "gatewayTokenEnv": "DASHBOARD_GATEWAY_TOKEN",
 *       "previewUrl": "https://dashboard.apps.example.nl"
 *   } ] }
 *
 * Tokens are never in the file: gatewayTokenEnv names the environment variable that holds it.
 */

export interface Project {
  id: string
  name: string
  workdir: string
  baseBranch: string
  sandbox: boolean
  gateway?: { url: string; token: string }
  previewUrl?: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function parseProjects(raw: unknown, env: Record<string, string | undefined> = process.env): Project[] {
  const root = raw as { projects?: unknown }
  if (!root || typeof root !== 'object' || !Array.isArray(root.projects) || root.projects.length === 0) {
    throw new ConfigError('config must be {"projects": [...]} with at least one project')
  }
  const seen = new Set<string>()
  return root.projects.map((entry: Record<string, unknown>) => {
    const id = entry?.id
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new ConfigError(`invalid project id: ${String(id)}`)
    if (seen.has(id)) throw new ConfigError(`duplicate project id: ${id}`)
    seen.add(id)
    const workdir = entry.workdir
    if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) throw new ConfigError(`${id}: workdir must be an absolute path`)
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new ConfigError(`${id}: workdir does not exist: ${workdir}`)
    if (!existsSync(path.join(workdir, '.git'))) throw new ConfigError(`${id}: workdir is not a git checkout`)
    const baseBranch = (entry.baseBranch ?? 'main') as string
    if (typeof baseBranch !== 'string' || !BRANCH_PATTERN.test(baseBranch) || baseBranch.startsWith('builder/')) {
      throw new ConfigError(`${id}: invalid baseBranch`)
    }
    let gateway: Project['gateway']
    if (entry.gatewayUrl !== undefined || entry.gatewayTokenEnv !== undefined) {
      if (typeof entry.gatewayUrl !== 'string' || typeof entry.gatewayTokenEnv !== 'string' || !ENV_PATTERN.test(entry.gatewayTokenEnv)) {
        throw new ConfigError(`${id}: gatewayUrl and gatewayTokenEnv must both be set`)
      }
      const token = env[entry.gatewayTokenEnv]
      if (!token) throw new ConfigError(`${id}: environment variable ${entry.gatewayTokenEnv} is not set`)
      gateway = { url: entry.gatewayUrl, token }
    }
    const previewUrl = entry.previewUrl
    if (previewUrl !== undefined && (typeof previewUrl !== 'string' || !/^https?:\/\//.test(previewUrl))) {
      throw new ConfigError(`${id}: previewUrl must be an http(s) url`)
    }
    return {
      id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : id,
      workdir: path.resolve(workdir),
      baseBranch,
      sandbox: entry.sandbox !== false,
      gateway,
      previewUrl: previewUrl as string | undefined,
    }
  })
}

/** What the browser may learn about a project: never paths or tokens. */
export function publicProject(project: Project) {
  return { id: project.id, name: project.name, baseBranch: project.baseBranch, sandbox: project.sandbox, previewUrl: project.previewUrl ?? null }
}
