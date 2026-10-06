import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { isProjectId } from '../../sandbox/src/ids.ts'
import { DEFAULT_PUBLISH, type PublishConfig } from '../../sandbox/src/release.ts'
import { runArgs } from '../../sandbox/src/sandbox.ts'

/*
 * Projects the builder app may change. Each project is a local git checkout of one app.
 *
 *   { "projects": [ {
 *       "id": "dashboard", "name": "Monteursdashboard",
 *       "workdir": "/srv/dig-builder/apps/dashboard",
 *       "baseBranch": "master",
 *       "sandbox": true,
 *       "gatewayUrl": "http://odoo-gateway:8070", "gatewayTokenEnv": "DASHBOARD_GATEWAY_TOKEN",
 *       "previewUrl": "https://dashboard.apps.example.nl",
 *       "publish": {
 *           "build": ["bun", "run", "build"], "start": ["bun", "run", "start"],
 *           "port": 3000, "healthPath": "/api/health",
 *           "gatewayUrl": "http://odoo-gateway:8070", "gatewayTokenEnv": "DASHBOARD_LIVE_GATEWAY_TOKEN",
 *           "url": "https://dashboard-live.apps.example.nl"
 *       }
 *   } ] }
 *
 * Tokens are never in the file: gatewayTokenEnv names the environment variable that holds it.
 * "publish" is optional; without it the project can only be previewed. The published app gets its
 * own gateway token (never the agent's), so it can be limited to what the live app needs.
 */

export interface Project {
  id: string
  name: string
  workdir: string
  baseBranch: string
  sandbox: boolean
  gateway?: { url: string; token: string }
  previewUrl?: string
  publish?: { config: PublishConfig; url?: string }
}

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
    if (!isProjectId(id)) throw new ConfigError(`invalid project id: ${String(id)}`)
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
    const publish = entry.publish === undefined ? undefined : parsePublish(id, entry.publish, env)
    return {
      id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : id,
      workdir: path.resolve(workdir),
      baseBranch,
      sandbox: entry.sandbox !== false,
      gateway,
      previewUrl: previewUrl as string | undefined,
      publish,
    }
  })
}

function parsePublish(id: string, raw: unknown, env: Record<string, string | undefined>): NonNullable<Project['publish']> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${id}: publish must be an object`)
  const entry = raw as Record<string, unknown>

  const command = (name: 'build' | 'start') => {
    const value = entry[name] ?? DEFAULT_PUBLISH[name]
    if (!Array.isArray(value) || value.length === 0 || value.length > 20 || value.some((part) => typeof part !== 'string' || !part || part.length > 200 || part.includes('\0'))) {
      throw new ConfigError(`${id}: publish.${name} must be a list of 1-20 non-empty strings`)
    }
    return value as string[]
  }
  const port = entry.port ?? DEFAULT_PUBLISH.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`${id}: publish.port must be a port number`)
  const healthPath = entry.healthPath ?? DEFAULT_PUBLISH.healthPath
  if (typeof healthPath !== 'string' || !/^\/[A-Za-z0-9._~/%?=&-]{0,200}$/.test(healthPath)) throw new ConfigError(`${id}: publish.healthPath must be a path starting with /`)

  const settings: Record<string, string> = {}
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) throw new ConfigError(`${id}: publish.env must be an object`)
    for (const [key, value] of Object.entries(entry.env)) {
      if (!ENV_PATTERN.test(key) || typeof value !== 'string') throw new ConfigError(`${id}: invalid publish.env entry ${key}`)
      settings[key] = value
    }
  }
  if (entry.gatewayUrl !== undefined || entry.gatewayTokenEnv !== undefined) {
    if (typeof entry.gatewayUrl !== 'string' || typeof entry.gatewayTokenEnv !== 'string' || !ENV_PATTERN.test(entry.gatewayTokenEnv)) {
      throw new ConfigError(`${id}: publish.gatewayUrl and publish.gatewayTokenEnv must both be set`)
    }
    const token = env[entry.gatewayTokenEnv]
    if (!token) throw new ConfigError(`${id}: environment variable ${entry.gatewayTokenEnv} is not set`)
    settings.DIG_GATEWAY_URL = entry.gatewayUrl
    settings.DIG_GATEWAY_TOKEN = token
  }
  const url = entry.url
  if (url !== undefined && (typeof url !== 'string' || !/^https?:\/\//.test(url))) throw new ConfigError(`${id}: publish.url must be an http(s) url`)

  const config: PublishConfig = { build: command('build'), start: command('start'), port, healthPath, env: settings }
  // The container rules (no secrets besides the gateway token, valid names) are checked now, not at the first publish.
  try {
    runArgs({ name: 'dig-live-check', workdir: '/x', user: '1000:1000', network: { internal: 'x' }, env: settings, command: config.start, persistent: true })
  } catch (error) {
    throw new ConfigError(`${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { config, url: url as string | undefined }
}

/** What the browser may learn about a project: never paths or tokens. */
export function publicProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    baseBranch: project.baseBranch,
    sandbox: project.sandbox,
    previewUrl: project.previewUrl ?? null,
    publish: project.publish ? { url: project.publish.url ?? null } : null,
  }
}
