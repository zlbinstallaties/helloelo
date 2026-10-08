import { createHash, randomBytes } from 'node:crypto'
import { hashPassword } from '../../sandbox/src/auth.ts'
import { isProjectId } from '../../sandbox/src/ids.ts'

/*
 * Everything the installer writes, as pure functions of the install state, so it can be tested
 * without a server. Nothing here touches the disk.
 */

export const USER = 'dig-builder'
export const NETWORK = 'dig-preview'
export const SANDBOX_IMAGE = 'dig-sandbox:1'
export const COMPOSE_PROJECT = 'dig-platform'
export const PATHS = {
  root: '/srv/dig-builder',
  app: '/srv/dig-builder/app',
  apps: '/srv/dig-builder/apps',
  data: '/srv/dig-builder/builder-data',
  releases: '/srv/dig-builder/releases',
  etc: '/etc/dig-builder',
  units: '/etc/systemd/system',
}
export const SERVICES = ['dig-preview', 'dig-builder-app'] as const
export const PREVIEW_PORT = 8090
export const BUILDER_PORT = 8100

export interface ProjectState {
  /** Used in hostnames and container names: lowercase letters, digits and dashes, not ending in -live. */
  id: string
  name: string
  repoUrl: string
  baseBranch: string
}

export interface InstallState {
  version: 1
  baseDomain: string
  odooUrl: string
  odooDatabase: string
  odooApiKey: string
  anthropicApiKey: string
  repoUrl: string
  branch: string
  projects: ProjectState[]
  passwordHash: string
  previewSessionSecret: string
  builderSessionSecret: string
  /** Gateway token of the agent and the previews, and a separate one for the published app. */
  devToken: string
  liveToken: string
}

export const builderHost = (state: InstallState) => `bouwen.${state.baseDomain}`
export const appsDomain = (state: InstallState) => `apps.${state.baseDomain}`
export const previewHost = (state: InstallState, id: string) => `${id}.${appsDomain(state)}`
export const liveHost = (state: InstallState, id: string) => `${id}-live.${appsDomain(state)}`
export const odooHost = (state: InstallState) => new URL(state.odooUrl).hostname

/** Environment variable that carries a project's gateway token for the agent (or, with live, the published app). */
export function tokenEnvName(id: string, live = false) {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}${live ? '_LIVE' : ''}_GATEWAY_TOKEN`
}

const SAFE_VALUE = /^[A-Za-z0-9._~+/=:@-]*$/

/** Values go into KEY=VALUE files read by systemd and docker compose; refuse anything they would interpret. */
export function envFile(entries: Record<string, string | number>) {
  const lines = Object.entries(entries).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`invalid variable name: ${key}`)
    if (!SAFE_VALUE.test(String(value))) throw new Error(`${key}: the value contains characters that cannot be stored safely in an env file`)
    return `${key}=${value}`
  })
  return `${lines.join('\n')}\n`
}

export function stackEnv(state: InstallState) {
  return envFile({
    ODOO_BASE_URL: state.odooUrl.replace(/\/+$/, ''),
    ODOO_API_KEY: state.odooApiKey,
    ODOO_ALLOWED_HOSTS: odooHost(state),
    ODOO_DATABASE: state.odooDatabase,
    GATEWAY_PROJECTS_FILE: `${PATHS.etc}/gateway-projects.json`,
  })
}

/** The gateway knows two projects with the same allowlist: one token for the agent and previews, one for the published app. */
export function gatewayProjects(example: { projects: Array<Record<string, unknown>> }, state: InstallState) {
  const base = example.projects[0]
  if (!base || typeof base.id !== 'string') throw new Error('gateway/projects.example.json has no project to copy')
  return {
    projects: [
      { ...base, tokenSha256: sha256(state.devToken) },
      { ...base, id: `${base.id}-live`, tokenSha256: sha256(state.liveToken) },
    ],
  }
}

export function previewEnv(state: InstallState) {
  return envFile({
    PREVIEW_DOMAIN: appsDomain(state),
    PREVIEW_PASSWORD_HASH: state.passwordHash,
    PREVIEW_SESSION_SECRET: state.previewSessionSecret,
    PREVIEW_PROJECTS_FILE: `${PATHS.etc}/previews.json`,
    PREVIEW_NETWORK: NETWORK,
    PREVIEW_RELEASES_DIR: PATHS.releases,
  })
}

export function previewProjects(state: InstallState) {
  return {
    projects: state.projects.map((p) => ({
      id: p.id,
      workdir: `${PATHS.apps}/${p.id}`,
      env: { DIG_GATEWAY_URL: 'http://odoo-gateway:8070', DIG_GATEWAY_TOKEN: state.devToken },
    })),
  }
}

export function builderProjects(state: InstallState) {
  return {
    projects: state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      workdir: `${PATHS.apps}/${p.id}`,
      baseBranch: p.baseBranch,
      sandbox: true,
      gatewayUrl: 'http://odoo-gateway:8070',
      gatewayTokenEnv: tokenEnvName(p.id),
      previewUrl: `https://${previewHost(state, p.id)}`,
      publish: {
        healthPath: '/api/health',
        gatewayUrl: 'http://odoo-gateway:8070',
        gatewayTokenEnv: tokenEnvName(p.id, true),
        url: `https://${liveHost(state, p.id)}`,
      },
    })),
  }
}

export function builderEnv(state: InstallState) {
  const tokens: Record<string, string> = {}
  for (const p of state.projects) {
    tokens[tokenEnvName(p.id)] = state.devToken
    tokens[tokenEnvName(p.id, true)] = state.liveToken
  }
  return envFile({
    BUILDER_APP_PROJECTS_FILE: `${PATHS.etc}/builder-projects.json`,
    BUILDER_APP_DATA_DIR: PATHS.data,
    BUILDER_APP_RELEASES_DIR: PATHS.releases,
    BUILDER_APP_PASSWORD_HASH: state.passwordHash,
    BUILDER_APP_SESSION_SECRET: state.builderSessionSecret,
    BUILDER_APP_PREVIEW_NETWORK: NETWORK,
    ...(state.anthropicApiKey ? { ANTHROPIC_API_KEY: state.anthropicApiKey } : {}),
    ...tokens,
  })
}

/**
 * The systemd units live in deploy/*.service. The installer only fills in what differs per server:
 * where node is, and the address of the docker bridge the services listen on.
 */
export function unit(template: string, node: string, bridgeIp: string) {
  if (!template.includes('/usr/bin/node') || !template.includes('172.17.0.1')) {
    throw new Error('the unit template no longer has the node path and bridge address the installer fills in')
  }
  return template.replaceAll('/usr/bin/node', node).replaceAll('172.17.0.1', bridgeIp)
}

/** The services only listen on this address: Caddy runs on the host network (or as a host service), so loopback is enough. */
export const LISTEN_IP = '127.0.0.1'

export const CADDY_BEGIN = '# BEGIN DIG Builder (managed by deploy/install; changes between BEGIN and END are overwritten)'
export const CADDY_END = '# END DIG Builder'

/** Explicit hostnames (no wildcard, no on-demand TLS), so the existing Caddy setup is left alone. */
export function caddyBlock(state: InstallState, listenIp = LISTEN_IP) {
  const apps = state.projects.flatMap((p) => [previewHost(state, p.id), liveHost(state, p.id)])
  return `${CADDY_BEGIN}
${builderHost(state)} {
	encode zstd gzip
	reverse_proxy ${listenIp}:${BUILDER_PORT}
}

${apps.join(', ')} {
	reverse_proxy ${listenIp}:${PREVIEW_PORT}
}
${CADDY_END}
`
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

// The proxy and the builder app verify with the same code, so the hash comes from there.
export { hashPassword }

export function newToken() {
  return `dgw_${randomBytes(32).toString('base64url')}`
}

export const validateProjectId = isProjectId
