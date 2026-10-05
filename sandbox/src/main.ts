import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createSessions } from './auth.ts'
import { createDockerCli } from './docker.ts'
import { createPreviewManager, type PreviewProject } from './preview.ts'
import { createPreviewProxy } from './proxy.ts'

/*
 * Preview proxy entry point.
 *
 *   PREVIEW_DOMAIN          e.g. preview.example.com (projects at <id>.preview.example.com)
 *   PREVIEW_PASSWORD_HASH   from `node --experimental-strip-types sandbox/src/hash-password.ts`
 *   PREVIEW_SESSION_SECRET  at least 32 random bytes
 *   PREVIEW_PROJECTS_FILE   JSON: {"projects": [{"id", "workdir", "command"?, "port"?, "env"?}]}
 *   PREVIEW_NETWORK         internal Docker network, default dig-preview
 *   PREVIEW_PORT            default 8090
 *   PREVIEW_SECURE_COOKIES  "false" only for local http testing
 *   PREVIEW_IDLE_MINUTES    default 30
 *
 * Needs access to the Docker daemon. Put TLS (a reverse proxy with a
 * wildcard certificate) in front of it.
 */

function required(name: string) {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} must be set`)
    process.exit(1)
  }
  return value
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/
const raw = JSON.parse(readFileSync(required('PREVIEW_PROJECTS_FILE'), 'utf8')) as { projects?: PreviewProject[] }
const projects = new Map<string, PreviewProject>()
for (const project of raw.projects ?? []) {
  if (!PROJECT_ID.test(project.id) || typeof project.workdir !== 'string') {
    console.error(`invalid preview project: ${JSON.stringify(project.id)}`)
    process.exit(1)
  }
  projects.set(project.id, project)
}

const domain = required('PREVIEW_DOMAIN').toLowerCase()
const previews = createPreviewManager({
  cli: createDockerCli(),
  network: process.env.PREVIEW_NETWORK || 'dig-preview',
  idleMs: Number(process.env.PREVIEW_IDLE_MINUTES ?? 30) * 60_000,
})
const proxy = createPreviewProxy({
  domain,
  passwordHash: required('PREVIEW_PASSWORD_HASH'),
  sessions: createSessions({ secret: required('PREVIEW_SESSION_SECRET') }),
  previews,
  projects,
  secureCookies: process.env.PREVIEW_SECURE_COOKIES !== 'false',
})

await previews.ensureNetwork()
const server = createServer(proxy.handleRequest)
server.on('upgrade', proxy.handleUpgrade)
const port = Number(process.env.PREVIEW_PORT ?? 8090)
server.listen(port, () => console.log(JSON.stringify({ event: 'listening', port, domain, projects: [...projects.keys()] })))

const reaper = setInterval(() => {
  previews.reap().then(
    (stopped) => stopped.length && console.log(JSON.stringify({ event: 'reaped', stopped })),
    (error) => console.error(JSON.stringify({ event: 'reap_failed', message: String(error) })),
  )
}, 60_000)

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(reaper)
    server.close(() => process.exit(0))
    // Open WebSocket tunnels keep close() waiting; do not hang on them.
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
