import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { createSessions } from '../../sandbox/src/auth.ts'
import { parseProjects } from './config.ts'
import { createRunManager } from './runs.ts'
import { createBuilderServer } from './server.ts'
import { createStore } from './store.ts'

/*
 * Builder app entry point.
 *
 *   BUILDER_APP_PROJECTS_FILE   JSON with the projects (see src/config.ts)
 *   BUILDER_APP_DATA_DIR        where run records live (outside every project checkout)
 *   BUILDER_APP_PASSWORD_HASH   from `bun run preview:password '<wachtwoord>'`
 *   BUILDER_APP_SESSION_SECRET  at least 32 random bytes
 *   BUILDER_APP_PORT            default 8100
 *   BUILDER_APP_HOST            default 127.0.0.1
 *   BUILDER_APP_SECURE_COOKIES  "false" only for local http testing
 *   BUILDER_APP_TRUST_PROXY     "true" behind a TLS proxy that sets X-Forwarded-For
 *   BUILDER_APP_MAX_RUNS        runs at the same time, default 2
 *   ANTHROPIC_API_KEY           for the agent (or another SDK credential source)
 *   DIG_SANDBOX_CA_BUNDLE       optional, for installs behind a TLS-intercepting proxy
 */

function required(name: string) {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} must be set`)
    process.exit(1)
  }
  return value
}

const here = path.dirname(new URL(import.meta.url).pathname)
const publicDir = path.join(here, '..', 'public')
const assets = {
  'index.html': { type: 'text/html; charset=utf-8', body: readFileSync(path.join(publicDir, 'index.html'), 'utf8') },
  'app.js': { type: 'text/javascript; charset=utf-8', body: readFileSync(path.join(publicDir, 'app.js'), 'utf8') },
  'style.css': { type: 'text/css; charset=utf-8', body: readFileSync(path.join(publicDir, 'style.css'), 'utf8') },
}

const projects = parseProjects(JSON.parse(readFileSync(required('BUILDER_APP_PROJECTS_FILE'), 'utf8')))
const dataDir = path.resolve(required('BUILDER_APP_DATA_DIR'))
for (const project of projects) {
  if (dataDir === project.workdir || dataDir.startsWith(project.workdir + path.sep)) {
    console.error(`BUILDER_APP_DATA_DIR must be outside the checkout of ${project.id}`)
    process.exit(1)
  }
}
await mkdir(dataDir, { recursive: true })

const store = createStore(dataDir)
const runs = createRunManager({
  projects,
  store,
  maxConcurrent: Number(process.env.BUILDER_APP_MAX_RUNS ?? 2),
  caBundle: process.env.DIG_SANDBOX_CA_BUNDLE || undefined,
})
await runs.recover()

const handler = createBuilderServer({
  projects,
  runs,
  store,
  passwordHash: required('BUILDER_APP_PASSWORD_HASH'),
  sessions: createSessions({ secret: required('BUILDER_APP_SESSION_SECRET') }),
  secureCookies: process.env.BUILDER_APP_SECURE_COOKIES !== 'false',
  trustProxy: process.env.BUILDER_APP_TRUST_PROXY === 'true',
  assets,
})

const server = createServer(handler)
const port = Number(process.env.BUILDER_APP_PORT ?? 8100)
const host = process.env.BUILDER_APP_HOST || '127.0.0.1'
server.listen(port, host, () => console.log(JSON.stringify({ event: 'listening', host, port, projects: projects.map((p) => p.id) })))

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
