// One-terminal runner for docs/lokaal-testen.md: demo Odoo + gateway + dashboard, started in the background
// from ONE terminal. NOT a real Odoo.
//
// With a `.local` that was made for another Odoo (bun run local:setup --odoo-url <your Odoo> ...), `start` runs
// only the gateway and the dashboard, on that `.local`, and changes nothing in it.
//
//   bun run local:rehearsal start    set up (first time), start the three, print the login
//   bun run local:rehearsal status   what runs
//   bun run local:rehearsal logs [demo|gateway|dashboard]   the last lines of a log (default: demo)
//   bun run local:rehearsal stop     stop the three
//   bun run local:rehearsal reset    stop and remove .local (only when it belongs to the demo)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = path.join(ROOT, '.local')
const RUN = path.join(LOCAL, 'run')
const LOGS = path.join(LOCAL, 'logs')
const DEMO_URL = 'http://127.0.0.1:18069'
const DASHBOARD_URL = 'http://127.0.0.1:3000'

const SERVICES = [
  { name: 'demo', label: 'demo-Odoo', script: 'local:demo-odoo', port: 18069, env: { DEMO_ODOO_PORT: '18069' }, ready: DEMO_URL, anyAnswer: true },
  { name: 'gateway', label: 'gateway', script: 'local:gateway', port: 8070, env: {}, ready: 'http://127.0.0.1:8070/healthz', anyAnswer: false },
  { name: 'dashboard', label: 'dashboard', script: 'local:dashboard', port: 3000, env: {}, ready: `${DASHBOARD_URL}/api/health`, anyAnswer: false },
]

const out = (line = '') => console.log(line)
const pidFile = (name) => path.join(RUN, `${name}.pid`)
const logFile = (name) => path.join(LOGS, `${name}.log`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function runningPid(name) {
  if (!existsSync(pidFile(name))) return null
  const pid = Number(readFileSync(pidFile(name), 'utf8'))
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function answers(service) {
  try {
    const response = await fetch(service.ready, { method: service.anyAnswer ? 'POST' : 'GET', signal: AbortSignal.timeout(1500) })
    return service.anyAnswer || response.ok
  } catch {
    return false
  }
}

/** True when `.local` was made for the demo Odoo (and so may be reused or removed by this script). */
function belongsToDemo() {
  try {
    return readFileSync(path.join(LOCAL, 'gateway.env'), 'utf8').split('\n').includes(`ODOO_BASE_URL=${DEMO_URL}`)
  } catch {
    return false
  }
}

function stop() {
  let stopped = 0
  for (const service of [...SERVICES].reverse()) {
    const pid = runningPid(service.name)
    if (pid !== null) {
      try {
        process.kill(-pid, 'SIGTERM') // the whole group: `bun run` and the node process under it
      } catch {
        try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      }
      stopped++
    }
    rmSync(pidFile(service.name), { force: true })
  }
  return stopped
}

/** The newest change time of a file under `dir` (0 when there is none). */
function newestChange(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestChange(file) : statSync(file).mtimeMs)
  }
  return newest
}

/** No build yet, or the code (src/, the package files, the config) changed after it: the screens would be old. */
function buildIsOld() {
  const built = path.join(ROOT, 'dist', 'server', 'server.js')
  if (!existsSync(built)) return 'er is nog geen bouw'
  const builtAt = statSync(built).mtimeMs
  const changed = Math.max(newestChange(path.join(ROOT, 'src')), ...['package.json', 'vite.config.ts', 'bun.lock'].map((file) => (existsSync(path.join(ROOT, file)) ? statSync(path.join(ROOT, file)).mtimeMs : 0)))
  return changed > builtAt ? 'de code is nieuwer dan de laatste bouw' : null
}

function envValue(file, name) {
  try {
    const line = readFileSync(path.join(LOCAL, file), 'utf8').split('\n').find((item) => item.startsWith(`${name}=`))
    return line ? line.slice(name.length + 1) : ''
  } catch {
    return ''
  }
}

async function start() {
  // A `.local` for another Odoo is used as it is: no demo Odoo, no setup, nothing written in it.
  const foreign = existsSync(LOCAL) && !belongsToDemo()
  const services = foreign ? SERVICES.filter((service) => service.name !== 'demo') : SERVICES
  if (foreign) {
    for (const file of ['gateway.env', 'dashboard.env', 'gateway-projects.json']) {
      if (!existsSync(path.join(LOCAL, file))) {
        out(`.local/${file} ontbreekt. Draai eerst:  bun run local:setup --odoo-url <adres van je Odoo> ...`)
        process.exit(1)
      }
    }
    if (!envValue('gateway.env', 'ODOO_API_KEY')) {
      out('ODOO_API_KEY= is leeg in .local/gateway.env. Vul de API-sleutel van je Odoo daar in en start opnieuw.')
      process.exit(1)
    }
  }
  const running = services.filter((service) => runningPid(service.name) !== null)
  if (running.length === services.length) {
    out('Alles draait al.')
    return status()
  }
  if (running.length > 0) {
    out(`Een deel draait al (${running.map((service) => service.label).join(', ')}); ik stop dat eerst.`)
    stop()
    await sleep(500)
  }
  for (const service of services) {
    if (!(await portFree(service.port))) {
      out(`Poort ${service.port} (${service.label}) is al bezet door iets anders.`)
      out(`Kijk wat het is:  lsof -nP -iTCP:${service.port} -sTCP:LISTEN`)
      out('Sluit dat (Ctrl+C in het tabblad waar het draait) en probeer opnieuw.')
      process.exit(1)
    }
  }

  let password = null
  if (!foreign && !existsSync(path.join(LOCAL, 'dashboard.env'))) {
    const setup = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/local-setup.ts',
      '--odoo-url', DEMO_URL, '--company-id', '2', '--responsible-id', '2', '--documents'], { cwd: ROOT, encoding: 'utf8' })
    if (setup.status !== 0) {
      out(`De setup is mislukt:\n${setup.stderr || setup.stdout}`)
      process.exit(1)
    }
    password = /Dashboard-login: {2}\S+ {2}\/ {2}(\S+)/.exec(setup.stdout)?.[1] ?? null
  }
  if (!foreign) {
    // The demo accepts any key.
    const gatewayEnv = readFileSync(path.join(LOCAL, 'gateway.env'), 'utf8')
    writeFileSync(path.join(LOCAL, 'gateway.env'), gatewayEnv.replace(/^ODOO_API_KEY=$/m, 'ODOO_API_KEY=demo'))
  }

  const oldBuild = buildIsOld()
  if (oldBuild) {
    out(`Het dashboard wordt gebouwd (${oldBuild}); even geduld...`)
    const build = spawnSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
    if (build.status !== 0) {
      out('Het bouwen is mislukt; zie hierboven.')
      process.exit(1)
    }
  }

  mkdirSync(RUN, { recursive: true })
  mkdirSync(LOGS, { recursive: true })
  for (const service of services) {
    const log = openSync(logFile(service.name), 'w')
    const child = spawn('bun', ['run', service.script], {
      cwd: ROOT,
      env: { ...process.env, ...service.env },
      detached: true,
      stdio: ['ignore', log, log],
    })
    child.on('error', (error) => {
      out(`Kon ${service.label} niet starten: ${error.message}`)
      process.exit(1)
    })
    child.unref()
    writeFileSync(pidFile(service.name), String(child.pid))
    let ready = false
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (runningPid(service.name) === null) break
      ready = await answers(service)
      if (!ready) await sleep(150)
    }
    if (!ready) {
      out(`${service.label} start niet goed op. Laatste regels:`)
      out(tail(service.name, 15))
      stop()
      process.exit(1)
    }
    out(`  ok  ${service.label} draait`)
  }

  out()
  out(`Klaar. Open ${DASHBOARD_URL} in je browser.`)
  if (foreign) {
    out(`Odoo: ${envValue('gateway.env', 'ODOO_BASE_URL')}  (de gateway praat daarmee, zie ook: bun run local:rehearsal logs gateway)`)
    out('Inloggen:  admin  met het wachtwoord dat local:setup toonde.')
  } else if (password) {
    out(`Inloggen:  admin  /  ${password}`)
    out('Bewaar dit wachtwoord nu: het staat nergens leesbaar op schijf. Vergeten? Dan: reset en start opnieuw.')
  } else {
    out('Inloggen:  admin  met het wachtwoord van de eerste start (vergeten? dan reset en start opnieuw).')
  }
  out()
  out(foreign ? 'De gatewaylog (elke aanroep naar Odoo):  bun run local:rehearsal logs gateway' : 'Elke aangemaakte monteur zie je met:  bun run local:rehearsal logs')
  out('Stoppen:                                bun run local:rehearsal stop')
}

function tail(name, lines = 20) {
  try {
    return readFileSync(logFile(name), 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return '(nog geen log)'
  }
}

async function status() {
  for (const service of SERVICES) {
    const pid = runningPid(service.name)
    out(`${pid === null ? 'uit ' : 'aan '} ${service.label.padEnd(10)} poort ${service.port}${pid === null ? '' : `  (pid ${pid})`}`)
  }
}

const [command = 'status', arg] = process.argv.slice(2)
if (command === 'start') await start()
else if (command === 'status') await status()
else if (command === 'logs') {
  const name = arg ?? 'demo'
  if (!SERVICES.some((service) => service.name === name)) {
    out(`Kies demo, gateway of dashboard.`)
    process.exit(1)
  }
  out(tail(name, 30))
} else if (command === 'stop') {
  const stopped = stop()
  out(stopped === 0 ? 'Er draaide niets (via dit script gestart).' : `${stopped} gestopt.`)
} else if (command === 'reset') {
  if (existsSync(LOCAL) && !belongsToDemo()) {
    out('.local hoort niet bij de demo-Odoo; ik verwijder het niet.')
    process.exit(1)
  }
  stop()
  rmSync(LOCAL, { recursive: true, force: true })
  out('.local is verwijderd. Met "start" begin je opnieuw, met een nieuw wachtwoord.')
} else {
  out('Gebruik: start | status | logs [demo|gateway|dashboard] | stop | reset')
  process.exit(1)
}
