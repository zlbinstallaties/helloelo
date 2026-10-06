import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Sys } from './sys.ts'
import {
  appsDomain, builderEnv, builderHost, builderProjects, BUILDER_PORT, CADDY_FILE, CADDY_MARK, caddySnippet, COMPOSE_PROJECT,
  gatewayProjects, importLine, liveHost, NETWORK, PATHS, previewEnv, previewHost, previewProjects, PREVIEW_PORT, SANDBOX_IMAGE,
  SERVICES, stackEnv, unit, USER, type InstallState,
} from './templates.ts'

/*
 * The installer's steps. Each one checks the machine first and only changes what is missing, so
 * running it again is safe and is also how an update is applied. Nothing here touches containers,
 * networks, files or web server settings that belong to anything else on the server.
 */

export class InstallError extends Error {
  hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'InstallError'
    this.hint = hint
  }
}

export interface CaddyFacts {
  binary: string
  config: string
}

export interface Facts {
  os: string
  isRoot: boolean
  nodeBinary: string
  nodeMajor: number
  docker: boolean
  compose: boolean
  git: boolean
  bridgeIp: string | null
  caddy: CaddyFacts | null
  publicIp: string | null
  /** A CA bundle for installs behind a TLS-intercepting proxy (DIG_SANDBOX_CA_BUNDLE); normally none. */
  caBundle: string | null
  /** Things that stop the installation, in words a person can act on. */
  problems: string[]
}

const ok = (result: { code: number }) => result.code === 0

async function out(sys: Sys, cmd: string, args: string[]) {
  const result = await sys.run(cmd, args)
  return ok(result) ? result.stdout.trim() : null
}

/** The Caddy that is already serving this machine: its binary and the Caddyfile it was started with. */
export function parseCaddyUnit(unitText: string): CaddyFacts | null {
  const line = unitText.split('\n').map((l) => l.trim()).find((l) => l.startsWith('ExecStart=') && /caddy/.test(l) && /\brun\b/.test(l))
  if (!line) return null
  const parts = line.slice('ExecStart='.length).trim().split(/\s+/)
  const binary = parts[0].replace(/^[-@:+!]+/, '')
  const flag = parts.findIndex((p) => p === '--config')
  const joined = parts.find((p) => p.startsWith('--config='))
  const config = joined ? joined.slice('--config='.length) : flag >= 0 ? parts[flag + 1] : '/etc/caddy/Caddyfile'
  return { binary, config }
}

export async function inspect(sys: Sys, env: Record<string, string | undefined> = process.env): Promise<Facts> {
  const problems: string[] = []
  const osRelease = (await sys.read('/etc/os-release')) ?? ''
  const os = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(osRelease)?.[1] ?? 'onbekend'
  const isRoot = (await out(sys, 'id', ['-u'])) === '0'
  if (!isRoot) problems.push('Dit script moet als root draaien (in de webconsole van Hostinger ben je dat al).')

  const nodeBinary = (await out(sys, 'sh', ['-c', 'command -v node'])) ?? ''
  const nodeMajor = Number(/^v(\d+)/.exec(process.version)?.[1] ?? 0)
  if (nodeMajor < 22) problems.push(`Node ${process.version} is te oud; Node 22 of nieuwer is nodig.`)
  if (!nodeBinary) problems.push('Het commando node is niet gevonden in het pad.')

  const docker = ok(await sys.run('docker', ['info']))
  if (!docker) problems.push('Docker is niet geïnstalleerd of draait niet.')
  const compose = ok(await sys.run('docker', ['compose', 'version']))
  if (docker && !compose) problems.push('Docker Compose (het commando "docker compose") ontbreekt.')
  const git = ok(await sys.run('git', ['--version']))
  if (!git) problems.push('Git is niet geïnstalleerd.')

  const bridgeIp = docker ? await out(sys, 'docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']) : null
  if (docker && !bridgeIp) problems.push('Het adres van het Docker-netwerk "bridge" is niet te vinden.')

  const unitText = await out(sys, 'systemctl', ['cat', 'caddy'])
  const caddy = unitText ? parseCaddyUnit(unitText) : null
  if (!caddy) {
    problems.push('Er draait geen Caddy als systeemdienst. Dit script haakt aan op een bestaande Caddy en start zelf geen webserver op poort 80/443.')
  } else if (!(await sys.exists(caddy.config)) || /\.json$/i.test(caddy.config)) {
    problems.push(`Caddy gebruikt ${caddy.config}; alleen een gewoon Caddyfile wordt ondersteund.`)
  }

  const publicIp = await out(sys, 'curl', ['-s', '-m', '5', 'https://api.ipify.org'])
  const caBundle = env.DIG_SANDBOX_CA_BUNDLE || null
  if (caBundle && !(await sys.exists(caBundle))) problems.push(`DIG_SANDBOX_CA_BUNDLE wijst naar ${caBundle}, maar dat bestand bestaat niet.`)
  return { os, isRoot, nodeBinary, nodeMajor, docker, compose, git, bridgeIp, caddy, publicIp, caBundle, problems }
}

export const STATE_FILE = `${PATHS.etc}/install.json`

export async function loadState(sys: Sys): Promise<InstallState | null> {
  const text = await sys.read(STATE_FILE)
  if (!text) return null
  const state = JSON.parse(text) as InstallState
  if (state.version !== 1) throw new InstallError(`${STATE_FILE} heeft een onbekende versie`)
  return state
}

export interface Ctx {
  sys: Sys
  state: InstallState
  facts: Facts
}

const app = (p: string) => path.join(PATHS.app, p)
const asUser = { user: USER }

function must(result: { code: number; stderr: string; stdout: string }, what: string, hint?: string) {
  if (result.code !== 0) throw new InstallError(`${what} mislukte: ${(result.stderr || result.stdout).trim().slice(0, 600)}`, hint)
}

async function ensureUser({ sys }: Ctx) {
  if (ok(await sys.run('id', ['-u', USER]))) {
    must(await sys.run('usermod', ['-aG', 'docker', USER]), `${USER} aan de groep docker toevoegen`)
    return `gebruiker ${USER} bestaat al`
  }
  must(
    await sys.run('useradd', ['--system', '--home-dir', PATHS.root, '--no-create-home', '--shell', '/usr/sbin/nologin', '--groups', 'docker', USER]),
    `gebruiker ${USER} aanmaken`,
  )
  return `gebruiker ${USER} aangemaakt`
}

async function ensureDirs({ sys }: Ctx) {
  const owner = `${USER}:${USER}`
  for (const dir of [PATHS.root, PATHS.apps, PATHS.data, PATHS.releases]) await sys.mkdir(dir, { mode: 0o750, owner })
  await sys.mkdir(PATHS.etc, { mode: 0o755, owner: 'root:root' })
  return 'mappen klaar'
}

async function ensureCode({ sys, state }: Ctx) {
  const notes: string[] = []
  // The checkout may have been made by root; git refuses a repository owned by someone else.
  if (await sys.exists(PATHS.app)) must(await sys.run('chown', ['-R', `${USER}:${USER}`, PATHS.app]), 'eigenaar van de code zetten')
  if (await sys.exists(app('.git'))) {
    must(await asUserRun(sys, 'git', ['-C', PATHS.app, 'fetch', '--quiet', 'origin', state.branch]), 'nieuwe code ophalen')
    const merged = await asUserRun(sys, 'git', ['-C', PATHS.app, 'merge', '--ff-only', '--quiet', `origin/${state.branch}`])
    must(merged, 'nieuwe code toepassen', 'De map /srv/dig-builder/app heeft eigen wijzigingen; verwijder ze of clone opnieuw.')
    notes.push('code bijgewerkt')
  } else {
    must(await asUserRun(sys, 'git', ['clone', '--quiet', '--branch', state.branch, state.repoUrl, PATHS.app], 300_000), 'code ophalen')
    notes.push('code opgehaald')
  }
  for (const project of state.projects) {
    const dir = `${PATHS.apps}/${project.id}`
    if (await sys.exists(`${dir}/.git`)) {
      notes.push(`${project.id}: bestaat al (de builder beheert deze map, wordt niet bijgewerkt)`)
      continue
    }
    must(await asUserRun(sys, 'git', ['clone', '--quiet', '--branch', project.baseBranch, project.repoUrl, dir], 300_000), `project ${project.id} ophalen`)
    notes.push(`${project.id}: opgehaald`)
  }
  return notes.join('; ')
}

function asUserRun(sys: Sys, cmd: string, args: string[], timeoutMs = 120_000) {
  return sys.run(cmd, args, { ...asUser, timeoutMs })
}

async function ensureImage({ sys, facts }: Ctx) {
  if (ok(await sys.run('docker', ['image', 'inspect', SANDBOX_IMAGE]))) return `afbeelding ${SANDBOX_IMAGE} bestaat al`
  const secret = facts.caBundle ? ['--secret', `id=ca,src=${facts.caBundle}`] : []
  must(await sys.run('docker', ['build', '--quiet', ...secret, '-t', SANDBOX_IMAGE, app('sandbox')], { timeoutMs: 900_000 }), `afbeelding ${SANDBOX_IMAGE} bouwen`)
  return `afbeelding ${SANDBOX_IMAGE} gebouwd`
}

async function ensureNetwork({ sys }: Ctx) {
  const inspected = await sys.run('docker', ['network', 'inspect', NETWORK, '--format', '{{.Internal}}'])
  if (ok(inspected)) {
    if (inspected.stdout.trim() !== 'true') {
      throw new InstallError(`Het Docker-netwerk ${NETWORK} bestaat al maar is niet intern (met internet).`, 'Dat netwerk is niet van dit script; verwijder of hernoem het zelf als het niet in gebruik is.')
    }
    return `netwerk ${NETWORK} bestaat al`
  }
  must(await sys.run('docker', ['network', 'create', '--internal', '--label', 'dig.preview=1', NETWORK]), `netwerk ${NETWORK} aanmaken`)
  return `netwerk ${NETWORK} aangemaakt (zonder internet voor de apps)`
}

async function writeConfig({ sys, state }: Ctx) {
  const example = await sys.read(app('gateway/projects.example.json'))
  if (!example) throw new InstallError('gateway/projects.example.json ontbreekt in de code')
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  // Secrets: root only. Files the services read themselves: readable for the service group, not for others.
  await sys.write(STATE_FILE, json(state), { mode: 0o600, owner: 'root:root' })
  await sys.write(`${PATHS.etc}/stack.env`, stackEnv(state), { mode: 0o600, owner: 'root:root' })
  await sys.write(`${PATHS.etc}/preview.env`, previewEnv(state), { mode: 0o600, owner: 'root:root' })
  await sys.write(`${PATHS.etc}/builder-app.env`, builderEnv(state), { mode: 0o600, owner: 'root:root' })
  // The gateway container reads this file as the unprivileged user "node"; it holds only token hashes.
  await sys.write(`${PATHS.etc}/gateway-projects.json`, json(gatewayProjects(JSON.parse(example), state)), { mode: 0o644, owner: 'root:root' })
  await sys.write(`${PATHS.etc}/previews.json`, json(previewProjects(state)), { mode: 0o640, owner: `root:${USER}` })
  await sys.write(`${PATHS.etc}/builder-projects.json`, json(builderProjects(state)), { mode: 0o640, owner: `root:${USER}` })
  return 'instellingen weggeschreven in /etc/dig-builder'
}

/** The builder app loads the agent library, which has two packages of its own (the Claude SDK and zod). */
async function installAgent({ sys }: Ctx) {
  const dir = app('agent')
  const lock = await sys.read(`${dir}/bun.lock`)
  if (lock === null) throw new InstallError('agent/bun.lock ontbreekt in de code')
  const stampFile = `${dir}/node_modules/.dig-installed`
  const stamp = createHash('sha256').update(lock).digest('hex')
  if ((await sys.read(stampFile)) === stamp) return 'dependencies van de agent staan er al'
  must(await sys.run('node', ['--experimental-strip-types', '--no-warnings', app('sandbox/src/cli.ts'), 'install', dir], { ...asUser, timeoutMs: 900_000 }), 'dependencies van de agent installeren')
  await sys.write(stampFile, stamp, { mode: 0o644, owner: `${USER}:${USER}` })
  return 'dependencies van de agent geïnstalleerd'
}

async function installProjects({ sys, state }: Ctx) {
  const notes: string[] = []
  for (const project of state.projects) {
    const dir = `${PATHS.apps}/${project.id}`
    if (await sys.exists(`${dir}/node_modules`)) {
      notes.push(`${project.id}: dependencies staan er al`)
      continue
    }
    const result = await sys.run('node', ['--experimental-strip-types', '--no-warnings', app('sandbox/src/cli.ts'), 'install', dir], { ...asUser, timeoutMs: 900_000 })
    must(result, `dependencies van ${project.id} installeren`)
    notes.push(`${project.id}: dependencies geïnstalleerd`)
  }
  return notes.join('; ')
}

export async function gatewayRunning(sys: Sys) {
  const listed = await sys.run('docker', ['ps', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`, '--filter', 'label=com.docker.compose.service=odoo-gateway', '--format', '{{.Names}}'])
  return ok(listed) && listed.stdout.trim().length > 0
}

async function startGateway({ sys, state }: Ctx) {
  if (!state.odooApiKey) return 'overgeslagen: nog geen Odoo-sleutel ingesteld (opnieuw uitvoeren zodra je die hebt)'
  const compose = ['compose', '--project-name', COMPOSE_PROJECT, '-f', app('deploy/docker-compose.yml'), '--env-file', `${PATHS.etc}/stack.env`]
  must(await sys.run('docker', [...compose, 'up', '-d', '--build', 'odoo-gateway'], { timeoutMs: 900_000 }), 'de Odoo-gateway starten')
  for (let i = 0; i < 20; i++) {
    const health = await sys.run('docker', ['ps', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`, '--filter', 'health=healthy', '--format', '{{.Names}}'])
    if (ok(health) && health.stdout.includes('odoo-gateway')) return 'gateway draait en is gezond'
    await sys.sleep(1500)
  }
  throw new InstallError('De Odoo-gateway werd niet gezond.', `Kijk met: docker logs ${COMPOSE_PROJECT}-odoo-gateway-1`)
}

async function startServices({ sys, facts }: Ctx) {
  const bridgeIp = facts.bridgeIp!
  for (const name of SERVICES) {
    const template = await sys.read(app(`deploy/${name}.service`))
    if (!template) throw new InstallError(`deploy/${name}.service ontbreekt in de code`)
    await sys.write(`${PATHS.units}/${name}.service`, unit(template, facts.nodeBinary, bridgeIp), { mode: 0o644, owner: 'root:root' })
  }
  must(await sys.run('systemctl', ['daemon-reload']), 'systemd opnieuw laden')
  for (const name of SERVICES) {
    must(await sys.run('systemctl', ['enable', name]), `${name} inschakelen`)
    must(await sys.run('systemctl', ['restart', name]), `${name} starten`)
  }
  await sys.sleep(3000)
  for (const name of SERVICES) {
    const active = await sys.run('systemctl', ['is-active', name])
    if (active.stdout.trim() !== 'active') {
      const log = await sys.run('journalctl', ['-u', name, '-n', '25', '--no-pager'])
      throw new InstallError(`${name} draait niet (${active.stdout.trim() || 'onbekend'}).\n${log.stdout.trim()}`)
    }
  }
  return 'diensten dig-preview en dig-builder-app draaien'
}

/** Status of the existing Odoo site: it must be the same before and after we touch the web server. */
async function odooStatus(sys: Sys, state: InstallState) {
  return sys.http(`${state.odooUrl.replace(/\/+$/, '')}/web/login`)
}

async function configureCaddy({ sys, state, facts }: Ctx) {
  const caddy = facts.caddy!
  const snippet = caddySnippet(state, facts.bridgeIp!)
  const main = (await sys.read(caddy.config)) ?? ''
  const previous = await sys.read(CADDY_FILE)
  const hasImport = main.includes(`import ${CADDY_FILE}`)
  if (previous === snippet && hasImport) return 'Caddy was al ingesteld'

  const before = await odooStatus(sys, state)
  const stamp = sys.now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${caddy.config}.dig-backup-${stamp}`
  await sys.write(backup, main, { mode: 0o600, owner: 'root:root' })

  const restore = async () => {
    await sys.write(caddy.config, main, { mode: 0o644, owner: 'root:root' })
    if (previous === null) await sys.remove(CADDY_FILE)
    else await sys.write(CADDY_FILE, previous, { mode: 0o644, owner: 'root:root' })
    await sys.run('systemctl', ['reload', 'caddy'])
  }

  await sys.write(CADDY_FILE, snippet, { mode: 0o644, owner: 'root:root' })
  if (!hasImport) await sys.write(caddy.config, `${main.replace(/\s*$/, '')}\n\n${importLine()}`, { mode: 0o644, owner: 'root:root' })

  const valid = await sys.run(caddy.binary, ['validate', '--config', caddy.config, '--adapter', 'caddyfile'])
  if (valid.code !== 0) {
    await restore()
    throw new InstallError(`Caddy keurt de nieuwe configuratie af; alles is teruggezet.\n${(valid.stderr || valid.stdout).trim().slice(0, 800)}`)
  }
  const reload = await sys.run('systemctl', ['reload', 'caddy'])
  if (reload.code !== 0) {
    await restore()
    throw new InstallError(`Caddy kon niet herladen; alles is teruggezet.\n${reload.stderr.trim().slice(0, 800)}`)
  }
  await sys.sleep(1500)
  const after = await odooStatus(sys, state)
  if (before !== after) {
    await restore()
    throw new InstallError(`De Odoo-testserver antwoordde vóór de wijziging met ${before ?? 'niets'} en erna met ${after ?? 'niets'}; alles is teruggezet.`)
  }
  return `Caddy herladen (Odoo-testserver antwoordt nog hetzelfde: ${before ?? 'geen antwoord'}); reservekopie ${backup}`
}

export interface Check {
  name: string
  url: string
  status: number | null
  ok: boolean
}

/** The addresses we check answer with a page or a redirect; any error status means something is wrong. */
const healthy = (status: number | null) => status !== null && status >= 200 && status < 400

export async function verify(sys: Sys, state: InstallState, facts: Facts, waitForCertificateMs = 120_000): Promise<Check[]> {
  const local = [
    { name: 'preview-proxy (lokaal)', url: `http://${facts.bridgeIp}:${PREVIEW_PORT}/_dig/login` },
    { name: 'builder-app (lokaal)', url: `http://${facts.bridgeIp}:${BUILDER_PORT}/` },
  ]
  const publicUrls = [
    { name: 'builder-app (publiek)', url: `https://${builderHost(state)}/` },
    ...state.projects.map((p) => ({ name: `preview ${p.id} (publiek)`, url: `https://${previewHost(state, p.id)}/_dig/login` })),
  ]
  const results: Check[] = []
  for (const item of local) {
    const status = await sys.http(item.url)
    results.push({ ...item, status, ok: healthy(status) })
  }
  const deadline = sys.now().getTime() + waitForCertificateMs
  for (const item of publicUrls) {
    let status = await sys.http(item.url)
    // The first request for a new hostname makes Caddy fetch a certificate, which takes a few seconds.
    while (!healthy(status) && sys.now().getTime() < deadline) {
      await sys.sleep(5000)
      status = await sys.http(item.url)
    }
    results.push({ ...item, status, ok: healthy(status) })
  }
  return results
}

export const APPLY_STEPS: Array<{ title: string; run: (ctx: Ctx) => Promise<string> }> = [
  { title: `Gebruiker ${USER}`, run: ensureUser },
  { title: 'Mappen', run: ensureDirs },
  { title: 'Code ophalen', run: ensureCode },
  { title: `Sandbox-afbeelding (${SANDBOX_IMAGE})`, run: ensureImage },
  { title: 'Dependencies van de bouwagent', run: installAgent },
  { title: `Docker-netwerk ${NETWORK}`, run: ensureNetwork },
  { title: 'Instellingen en geheimen', run: writeConfig },
  { title: 'Dependencies van de projecten', run: installProjects },
  { title: 'Odoo-gateway', run: startGateway },
  { title: 'Diensten (preview-proxy en builder-app)', run: startServices },
  { title: 'Bestaande Caddy aanvullen', run: configureCaddy },
]

/** Every address that will exist after the installation, for the plan and the summary. */
export function addresses(state: InstallState) {
  return {
    builder: `https://${builderHost(state)}`,
    projects: state.projects.map((p) => ({ id: p.id, preview: `https://${previewHost(state, p.id)}`, live: `https://${liveHost(state, p.id)}` })),
    appsDomain: appsDomain(state),
  }
}

export { CADDY_MARK }

const LABELS = ['dig.live', 'dig.preview', 'dig.sandbox', `com.docker.compose.project=${COMPOSE_PROJECT}`]

/** Containers that belong to this installation, found by label: never by guessing at names. */
async function ownContainers(sys: Sys) {
  const names = new Set<string>()
  for (const label of LABELS) {
    const listed = await sys.run('docker', ['ps', '-a', '--filter', `label=${label}`, '--format', '{{.Names}}'])
    if (ok(listed)) for (const name of listed.stdout.split('\n').map((n) => n.trim()).filter(Boolean)) names.add(name)
  }
  return [...names]
}

export interface UninstallOptions {
  /** Also delete code, run history, published versions, secrets and the user. */
  purge: boolean
}

/** Takes the installation away again and leaves everything else on the server alone. */
export async function uninstall(sys: Sys, facts: Facts, options: UninstallOptions): Promise<string[]> {
  const done: string[] = []
  for (const name of SERVICES) {
    await sys.run('systemctl', ['disable', '--now', name])
    await sys.remove(`${PATHS.units}/${name}.service`)
  }
  await sys.run('systemctl', ['daemon-reload'])
  done.push('diensten gestopt en verwijderd')

  if (facts.caddy) {
    const main = await sys.read(facts.caddy.config)
    if (main !== null && (main.includes(CADDY_MARK) || main.includes(CADDY_FILE))) {
      const lines = main.split('\n').filter((line) => !line.includes(CADDY_MARK) && !line.includes(`import ${CADDY_FILE}`))
      const stamp = sys.now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      await sys.write(`${facts.caddy.config}.dig-backup-${stamp}`, main, { mode: 0o600, owner: 'root:root' })
      await sys.write(facts.caddy.config, `${lines.join('\n').replace(/\s*$/, '')}\n`, { mode: 0o644, owner: 'root:root' })
      await sys.remove(CADDY_FILE)
      const valid = await sys.run(facts.caddy.binary, ['validate', '--config', facts.caddy.config, '--adapter', 'caddyfile'])
      if (valid.code !== 0) throw new InstallError(`Caddy keurt de configuratie na het verwijderen af: ${valid.stderr.trim().slice(0, 500)}`, `Een reservekopie staat naast ${facts.caddy.config}.`)
      must(await sys.run('systemctl', ['reload', 'caddy']), 'Caddy herladen')
      done.push('Caddy-aanvulling verwijderd en Caddy herladen')
    }
  }

  const containers = await ownContainers(sys)
  if (containers.length) await sys.run('docker', ['rm', '-f', ...containers])
  done.push(`${containers.length} containers van dit systeem verwijderd`)
  // The compose file needs its variables to be read at all, so "down" gets the same env file as "up".
  if ((await sys.exists(app('deploy/docker-compose.yml'))) && (await sys.exists(`${PATHS.etc}/stack.env`))) {
    await sys.run('docker', ['compose', '--project-name', COMPOSE_PROJECT, '-f', app('deploy/docker-compose.yml'), '--env-file', `${PATHS.etc}/stack.env`, 'down', '--remove-orphans'], { timeoutMs: 120_000 })
  }
  await sys.run('docker', ['network', 'rm', `${COMPOSE_PROJECT}_default`])
  done.push('Odoo-gateway gestopt')
  if (!ok(await sys.run('docker', ['network', 'inspect', NETWORK]))) done.push(`netwerk ${NETWORK} bestond niet meer`)
  else done.push(ok(await sys.run('docker', ['network', 'rm', NETWORK])) ? `netwerk ${NETWORK} verwijderd` : `netwerk ${NETWORK} bleef staan (er hangt nog iets aan)`)

  if (options.purge) {
    await sys.run('docker', ['rmi', SANDBOX_IMAGE, `${COMPOSE_PROJECT}-odoo-gateway`])
    for (const dir of [PATHS.root, PATHS.etc]) await sys.remove(dir)
    await sys.run('userdel', [USER])
    done.push(`${PATHS.root}, ${PATHS.etc} en de gebruiker ${USER} verwijderd (reservekopieën van het Caddyfile blijven naast het bestand staan)`)
  } else {
    done.push(`code, gegevens en geheimen blijven staan (${PATHS.root}, ${PATHS.etc}); zet "purge" erbij om ze te verwijderen`)
  }
  return done
}
