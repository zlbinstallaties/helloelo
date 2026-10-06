// Look at the running app with realistic demo data.
//
//   node scripts/probe.mjs -- /api/dashboard?scope=all /api/health
//
// Builds the app, starts it against a built-in fake Odoo gateway that serves the fixtures of
// scripts/demo-data.mjs (including awkward cases), requests the given GET paths and prints status and
// body. Everything happens on loopback in this one process tree, so it runs fine in a sandbox container
// without network. This is a quick look at server responses, not a browser: it does not render the UI.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { demoData } from './demo-data.mjs'

const MAX_PATHS = 5
const MAX_BODY_CHARS = 20_000
const PATH_PATTERN = /^\/[A-Za-z0-9_\-./?=&%:+,~]*$/
const TOKEN = 'probe-token'

const separator = process.argv.indexOf('--')
const paths = separator === -1 ? [] : process.argv.slice(separator + 1)
if (paths.length === 0 || paths.length > MAX_PATHS) {
  console.error(`usage: node scripts/probe.mjs -- <path> [... up to ${MAX_PATHS}]`)
  process.exit(2)
}
for (const path of paths) {
  if (path.length > 200 || path.startsWith('//') || !PATH_PATTERN.test(path)) {
    console.error(`invalid path: ${path}`)
    process.exit(2)
  }
}

if (process.env.PROBE_SKIP_BUILD !== '1') {
  const build = spawnSync('node_modules/.bin/vite', ['build'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', CI: '1', NO_COLOR: '1' } })
  if (build.status !== 0) {
    console.error(`build failed (exit ${build.status}):\n${`${build.stdout}${build.stderr}`.slice(-4000)}`)
    process.exit(1)
  }
}

// Fake gateway: the same wire format as the DIG Odoo gateway, backed by the fixtures.
const data = demoData()
const gateway = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const match = /^\/v1\/models\/([a-z0-9_.]+)\/search_read$/.exec(req.url ?? '')
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' })
  if (!match || !data[match[1]]) return send(404, { error: 'model_not_allowed' })
  const body = raw ? JSON.parse(raw) : {}
  const rows = data[match[1]].slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 500))
  const wanted = Array.isArray(body.fields) && body.fields.length ? body.fields : null
  const records = rows.map((row) => (wanted ? Object.fromEntries(wanted.filter((f) => f in row).map((f) => [f, row[f]])) : row))
  send(200, { records, count: records.length, limit: body.limit ?? 500, offset: body.offset ?? 0 })
})
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
const gatewayPort = gateway.address().port

// Pick a free port for the app.
const probePort = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

const app = spawn('node', ['scripts/serve.mjs'], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? '/tmp',
    NODE_ENV: 'production',
    PORT: String(probePort),
    HOST: '127.0.0.1',
    // The probe looks at the data with demo data, not at the login: logins are off here.
    DIG_AUTH: 'off',
    DIG_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    DIG_GATEWAY_TOKEN: TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (chunk) => (appLog += chunk))
app.stderr.on('data', (chunk) => (appLog += chunk))

function shutdown(code) {
  app.kill('SIGKILL')
  gateway.close()
  process.exit(code)
}

let exited = false
app.on('exit', () => (exited = true))
const base = `http://127.0.0.1:${probePort}`
let ready = false
for (let i = 0; i < 100 && !ready && !exited; i++) {
  try {
    ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}
if (!ready) {
  console.error(`the app did not start:\n${appLog.slice(-3000)}`)
  shutdown(1)
}

for (const path of paths) {
  let response
  try {
    response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' })
  } catch (error) {
    console.log(`### GET ${path}\nrequest failed: ${error instanceof Error ? error.message : String(error)}\n`)
    continue
  }
  const type = response.headers.get('content-type') ?? ''
  const text = await response.text()
  let shown = text
  if (type.includes('json')) {
    try {
      shown = JSON.stringify(JSON.parse(text))
    } catch {
      // keep the raw text
    }
  }
  const limit = type.includes('json') ? MAX_BODY_CHARS : 1500
  console.log(`### GET ${path} -> ${response.status} ${type.split(';')[0]}\n${shown.slice(0, limit)}${shown.length > limit ? `\n[... ${shown.length - limit} tekens ingekort]` : ''}\n`)
}
shutdown(0)
