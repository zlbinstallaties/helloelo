import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { containerIp, docker, type DockerCli } from './docker.ts'
import { isProjectId } from './ids.ts'
import { ownerOf, runArgs, type Sandbox, type SandboxLimits } from './sandbox.ts'

/*
 * Published versions of an app.
 *
 * A release is a clean export of one commit (no .git), with its dependencies
 * installed and its production build made in the sandbox. It runs in its own
 * long-lived container on the internal preview network, with a read-only app
 * directory. Publishing is "blue/green": the new container is started and must
 * answer before the pointer (current.json) moves, so a release that does not
 * build or start never replaces the version people are using. Rolling back is
 * the same switch to an older release that is still on disk.
 *
 *   <releasesDir>/<project>/current.json            what the proxy serves
 *   <releasesDir>/<project>/releases/<id>/app/      the exported, built app
 *   <releasesDir>/<project>/releases/<id>/meta.json commit, time, container
 *
 * Nothing secret is written to disk: environment variables (the scoped
 * gateway token) only go to `docker run`.
 */

const exec = promisify(execFile)

export const LIVE_LABEL = 'dig.live'
const RELEASE_LABEL = 'dig.release'
const BRANCH_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/
const RELEASE_ID = /^[a-z0-9]{1,10}-[0-9a-f]{7}$/
const CONTAINER_NAME = /^dig-live-[a-z0-9_.-]{1,50}$/
const COMMIT = /^[0-9a-f]{40}$/

export interface PublishConfig {
  /** Run once in the sandbox without network, in the app directory. */
  build: readonly string[]
  /** Runs in the live container; must listen on `port` on all interfaces. */
  start: readonly string[]
  port: number
  /** GET path that must answer (any status below 500) before the release goes live. */
  healthPath: string
  /** Non-secret settings plus at most the scoped DIG_GATEWAY_TOKEN. */
  env: Record<string, string>
}

export const DEFAULT_PUBLISH: Omit<PublishConfig, 'env'> = {
  build: ['bun', 'run', 'build'],
  start: ['bun', 'run', 'start'],
  port: 3000,
  healthPath: '/',
}

export type PublishPhase = 'export' | 'install' | 'build' | 'start' | 'check' | 'switch'

export interface ReleaseInfo {
  id: string
  commit: string
  createdAt: string
  container: string
  port: number
}

export interface Current {
  releaseId: string
  commit: string
  container: string
  port: number
  publishedAt: string
}

export class PublishError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PublishError'
    this.code = code
  }
}

export function liveContainerName(projectId: string, releaseId: string) {
  return `dig-live-${projectId.slice(0, 24)}-${releaseId}`
}

function projectDir(releasesDir: string, id: string) {
  return path.join(releasesDir, id)
}

function currentPath(releasesDir: string, id: string) {
  return path.join(projectDir(releasesDir, id), 'current.json')
}

function parseCurrent(raw: unknown): Current | null {
  const value = raw as Partial<Current> | null
  if (!value || typeof value !== 'object') return null
  const port = Number(value.port)
  if (
    typeof value.releaseId !== 'string' || !RELEASE_ID.test(value.releaseId) ||
    typeof value.commit !== 'string' || !COMMIT.test(value.commit) ||
    typeof value.container !== 'string' || !CONTAINER_NAME.test(value.container) ||
    !Number.isInteger(port) || port < 1 || port > 65535 ||
    typeof value.publishedAt !== 'string'
  ) return null
  return { releaseId: value.releaseId, commit: value.commit, container: value.container, port, publishedAt: value.publishedAt }
}

async function readCurrent(releasesDir: string, id: string): Promise<Current | null> {
  try {
    return parseCurrent(JSON.parse(await readFile(currentPath(releasesDir, id), 'utf8')))
  } catch {
    return null
  }
}

function tail(text: string, max = 1500) {
  const clean = text.trim()
  return clean.length > max ? `…${clean.slice(-max)}` : clean
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

/**
 * The part of a failed command's output a person needs: no colour codes, no stack frames, no empty or
 * box-drawing lines. Long output keeps its beginning (where build tools name the error) and its end.
 */
export function excerpt(output: string, max = 1600) {
  const clean = output
    .replace(ANSI, '')
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s+at\s/.test(line) && !/^[\s│╭╰─┬┴┼╯╮]+$/.test(line))
    .join('\n')
  if (clean.length <= max) return clean
  const head = Math.floor(max * 0.4)
  return `${clean.slice(0, head)}\n…\n${clean.slice(-(max - head))}`
}

/** HTTP status of a GET, or null when nothing answered. */
async function defaultProbe(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' })
    await response.arrayBuffer().catch(() => {})
    return response.status
  } catch {
    return null
  }
}

export interface PublisherOptions {
  cli: DockerCli
  sandbox: Pick<Sandbox, 'install' | 'exec'>
  releasesDir: string
  /** The internal preview network the live containers join. */
  network: string
  image?: string
  limits?: SandboxLimits
  /** Releases kept on disk for rolling back, the live one included. Default 3. */
  keep?: number
  now?: () => Date
  readyTimeoutMs?: number
  /** Pause between the switch and removing the old container, so in-flight requests finish. */
  graceMs?: number
  /** GET the health path; the HTTP status, or null when nothing answered. Below 500 counts as healthy. */
  probe?: (url: string) => Promise<number | null>
  owner?: typeof ownerOf
  sleep?: (ms: number) => Promise<void>
}

export function createPublisher(options: PublisherOptions) {
  const { cli, sandbox, releasesDir, network } = options
  const keep = Math.max(2, options.keep ?? 3)
  const now = options.now ?? (() => new Date())
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000
  const graceMs = options.graceMs ?? 5000
  const probe = options.probe ?? defaultProbe
  const owner = options.owner ?? ownerOf
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const busy = new Set<string>()

  const releaseDir = (id: string, releaseId: string) => path.join(projectDir(releasesDir, id), 'releases', releaseId)

  async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (!isProjectId(id)) throw new PublishError('invalid_project', `Ongeldig project: ${id}`)
    if (busy.has(id)) throw new PublishError('publish_busy', 'Er wordt al gepubliceerd voor dit project.')
    busy.add(id)
    try {
      return await work()
    } finally {
      busy.delete(id)
    }
  }

  async function readMeta(id: string, releaseId: string): Promise<ReleaseInfo | null> {
    try {
      const meta = JSON.parse(await readFile(path.join(releaseDir(id, releaseId), 'meta.json'), 'utf8')) as ReleaseInfo
      return meta && meta.id === releaseId && COMMIT.test(meta.commit) ? meta : null
    } catch {
      return null
    }
  }

  async function list(id: string): Promise<{ current: Current | null; releases: ReleaseInfo[] }> {
    if (!isProjectId(id)) throw new PublishError('invalid_project', `Ongeldig project: ${id}`)
    const current = await readCurrent(releasesDir, id)
    let names: string[] = []
    try {
      names = await readdir(path.join(projectDir(releasesDir, id), 'releases'))
    } catch { /* nothing published yet */ }
    const releases: ReleaseInfo[] = []
    for (const name of names) {
      if (!RELEASE_ID.test(name)) continue
      const meta = await readMeta(id, name)
      if (meta) releases.push(meta)
    }
    releases.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { current, releases }
  }

  async function git(workdir: string, args: string[]) {
    const result = await exec('git', ['-C', workdir, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      maxBuffer: 10 * 1024 * 1024,
    })
    return result.stdout.trim()
  }

  async function removeContainer(name: string) {
    await cli.run(['rm', '-f', name], { timeoutMs: 30_000 })
  }

  async function startContainer(id: string, info: ReleaseInfo, config: PublishConfig) {
    const app = path.join(releaseDir(id, info.id), 'app')
    const dir = await owner(app)
    // A stopped container of this release (e.g. after "docker stop") keeps its name.
    await removeContainer(info.container)
    const args = runArgs({
      name: info.container,
      workdir: dir.path,
      user: dir.user,
      network: { internal: network },
      env: { ...config.env, PORT: String(config.port), HOST: '0.0.0.0', NODE_ENV: 'production' },
      labels: { [LIVE_LABEL]: id, [RELEASE_LABEL]: info.id },
      limits: options.limits,
      image: options.image,
      detach: true,
      persistent: true,
      readOnlyWorkdir: true,
      command: config.start,
    })
    const result = await cli.run(args, { timeoutMs: 60_000 })
    if (result.code !== 0) throw new PublishError('start_failed', `De container startte niet: ${tail(result.stderr)}`)
  }

  /** Waits until the app answers on its health path; returns the container IP. */
  async function waitReady(info: ReleaseInfo, config: PublishConfig): Promise<string> {
    const deadline = Date.now() + readyTimeoutMs
    let lastStatus: number | null = null
    for (;;) {
      const ip = await containerIp(cli, info.container, network)
      if (ip) {
        lastStatus = await probe(`http://${ip}:${config.port}${config.healthPath}`)
        if (lastStatus !== null && lastStatus < 500) return ip
      } else {
        const state = await cli.run(['inspect', '-f', '{{.State.Running}}', info.container], { timeoutMs: 30_000 })
        if (state.code !== 0 || state.stdout.trim() !== 'true') break
      }
      if (Date.now() >= deadline) break
      await sleep(1000)
    }
    const logs = await cli.run(['logs', '--tail', '30', info.container], { timeoutMs: 30_000 })
    const output = excerpt(`${logs.stdout}${logs.stderr}`) || '(geen uitvoer)'
    if (lastStatus !== null) {
      throw new PublishError('not_ready', `De nieuwe versie draait, maar ${config.healthPath} antwoordde met status ${lastStatus} in plaats van een goede status. Zo gaat hij niet live.\n${output}`)
    }
    throw new PublishError('not_ready', `De nieuwe versie start niet op.\n${output}`)
  }

  async function writeCurrent(id: string, info: ReleaseInfo) {
    const current: Current = { releaseId: info.id, commit: info.commit, container: info.container, port: info.port, publishedAt: now().toISOString() }
    const file = currentPath(releasesDir, id)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, `${JSON.stringify(current, null, 2)}\n`)
    await rename(`${file}.tmp`, file)
  }

  /** Starts the release (if needed), waits until it answers, then moves the pointer to it. */
  async function activate(id: string, info: ReleaseInfo, config: PublishConfig, onPhase?: (phase: PublishPhase) => void) {
    onPhase?.('start')
    const running = await containerIp(cli, info.container, network)
    let started = false
    if (!running) {
      await startContainer(id, info, config)
      started = true
    }
    try {
      onPhase?.('check')
      await waitReady(info, config)
    } catch (error) {
      if (started) await removeContainer(info.container)
      throw error
    }
    onPhase?.('switch')
    await writeCurrent(id, info)
    // From here on the new version is live; cleaning up the old one must never fail the switch.
    try {
      if (graceMs) await sleep(graceMs)
      const listed = await docker(cli, ['ps', '-a', '--filter', `label=${LIVE_LABEL}=${id}`, '--format', '{{.Names}}'])
      for (const name of listed.split('\n').filter(Boolean)) {
        if (name !== info.container) await removeContainer(name)
      }
    } catch { /* the next publish removes leftovers */ }
  }

  async function prune(id: string) {
    const { current, releases } = await list(id)
    for (const release of releases.slice(keep)) {
      if (release.id === current?.releaseId) continue
      await rm(releaseDir(id, release.id), { recursive: true, force: true })
    }
  }

  async function publish(input: { id: string; workdir: string; ref: string; config: PublishConfig; onPhase?: (phase: PublishPhase) => void }): Promise<ReleaseInfo> {
    const { id, workdir, ref, config, onPhase } = input
    return exclusive(id, async () => {
      if (!BRANCH_REF.test(ref)) throw new PublishError('invalid_ref', `Ongeldige branch: ${ref}`)
      onPhase?.('export')
      let commit: string
      try {
        commit = await git(workdir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      } catch {
        throw new PublishError('invalid_ref', `De branch ${ref} bestaat niet in dit project.`)
      }
      if (!COMMIT.test(commit)) throw new PublishError('invalid_ref', `De branch ${ref} bestaat niet in dit project.`)
      const before = await readCurrent(releasesDir, id)
      if (before?.commit === commit) throw new PublishError('already_current', 'Deze versie is al gepubliceerd.')

      const releaseId = `${Math.floor(now().getTime() / 1000).toString(36)}-${commit.slice(0, 7)}`
      const dir = releaseDir(id, releaseId)
      const app = path.join(dir, 'app')
      const info: ReleaseInfo = { id: releaseId, commit, createdAt: now().toISOString(), container: liveContainerName(id, releaseId), port: config.port }
      await mkdir(app, { recursive: true })
      try {
        const tar = path.join(dir, 'source.tar')
        await git(workdir, ['archive', '--format=tar', '-o', tar, commit])
        await exec('tar', ['-xf', tar, '-C', app])
        await rm(tar, { force: true })

        onPhase?.('install')
        const install = await sandbox.install(app)
        if (!install.ok) throw new PublishError('build_failed', `De dependencies konden niet worden geïnstalleerd.\n${excerpt(install.output)}`)
        onPhase?.('build')
        const build = await sandbox.exec(app, config.build, { network: 'none', timeoutMs: 900_000 })
        if (!build.ok) throw new PublishError('build_failed', `De build mislukte${build.timedOut ? ' (te lang)' : ''}.\n${excerpt(build.output)}`)

        await writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(info, null, 2)}\n`)
        await activate(id, info, config, onPhase)
      } catch (error) {
        // Never delete a release that the pointer already moved to.
        if ((await readCurrent(releasesDir, id))?.releaseId !== releaseId) {
          await removeContainer(info.container).catch(() => {})
          await rm(dir, { recursive: true, force: true })
        }
        throw error
      }
      await prune(id)
      return info
    })
  }

  /** Switches to an older release (default: the one before the current), or restarts the current one. */
  async function activateExisting(id: string, config: PublishConfig, pick: (data: Awaited<ReturnType<typeof list>>) => ReleaseInfo, onPhase?: (phase: PublishPhase) => void) {
    return exclusive(id, async () => {
      const data = await list(id)
      const target = pick(data)
      await activate(id, target, config, onPhase)
      return target
    })
  }

  function rollback(input: { id: string; config: PublishConfig; releaseId?: string; onPhase?: (phase: PublishPhase) => void }) {
    return activateExisting(input.id, input.config, ({ current, releases }) => {
      if (!current) throw new PublishError('no_release', 'Er is nog niets gepubliceerd.')
      if (input.releaseId !== undefined) {
        if (input.releaseId === current.releaseId) throw new PublishError('already_current', 'Deze versie is al gepubliceerd.')
        const chosen = releases.find((r) => r.id === input.releaseId)
        if (!chosen) throw new PublishError('unknown_release', 'Die versie is niet meer beschikbaar.')
        return chosen
      }
      const at = releases.findIndex((r) => r.id === current.releaseId)
      const previous = at >= 0 ? releases[at + 1] : releases[0]
      if (!previous) throw new PublishError('no_release', 'Er is geen eerdere versie om naar terug te gaan.')
      return previous
    }, input.onPhase)
  }

  /** Starts the current release again (it stopped, or its container was removed). */
  function restart(input: { id: string; config: PublishConfig; onPhase?: (phase: PublishPhase) => void }) {
    return activateExisting(input.id, input.config, ({ current, releases }) => {
      if (!current) throw new PublishError('no_release', 'Er is nog niets gepubliceerd.')
      const release = releases.find((r) => r.id === current.releaseId)
      if (!release) throw new PublishError('unknown_release', 'De gepubliceerde versie staat niet meer op schijf.')
      return release
    }, input.onPhase)
  }

  return { publish, rollback, restart, list }
}

export type Publisher = ReturnType<typeof createPublisher>

export type LiveState = { state: 'ready'; target: string } | { state: 'down' } | { state: 'none' }

export interface LiveResolverOptions {
  cli: DockerCli
  releasesDir: string
  network: string
  /** How long a lookup is reused. Default 2 seconds. */
  ttlMs?: number
  now?: () => number
}

/** What the proxy uses to find the container of the published version of a project. */
export function createLiveResolver(options: LiveResolverOptions) {
  const ttlMs = options.ttlMs ?? 2000
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; value: Promise<LiveState> }>()

  async function lookup(id: string): Promise<LiveState> {
    const current = await readCurrent(options.releasesDir, id)
    if (!current) return { state: 'none' }
    const ip = await containerIp(options.cli, current.container, options.network)
    return ip ? { state: 'ready', target: `http://${ip}:${current.port}` } : { state: 'down' }
  }

  return {
    /** True when something is published for this project (used for the TLS certificate check). */
    exists(id: string) {
      return isProjectId(id) && existsSync(currentPath(options.releasesDir, id))
    },
    resolve(id: string): Promise<LiveState> {
      if (!isProjectId(id)) return Promise.resolve({ state: 'none' })
      const hit = cache.get(id)
      if (hit && now() - hit.at < ttlMs) return hit.value
      const value = lookup(id).catch((): LiveState => ({ state: 'down' }))
      cache.set(id, { at: now(), value })
      return value
    },
  }
}

export type LiveResolver = ReturnType<typeof createLiveResolver>
