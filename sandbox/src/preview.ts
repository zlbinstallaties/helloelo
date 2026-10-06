import { connect } from 'node:net'
import { containerIp, docker, DockerError, type DockerCli } from './docker.ts'
import { isProjectId } from './ids.ts'
import { ownerOf, runArgs, type SandboxLimits } from './sandbox.ts'

/*
 * One long-running preview container per project, on an internal Docker
 * network (no internet). The proxy reaches it by container IP. Previews that
 * nobody requests for `idleMs` are stopped.
 */

export interface PreviewProject {
  id: string
  workdir: string
  /** Dev server command, run in /work. Must listen on 0.0.0.0:<port>. */
  command?: readonly string[]
  port?: number
  /** Non-secret settings plus at most the scoped DIG_GATEWAY_TOKEN. */
  env?: Record<string, string>
}

export type PreviewState =
  | { state: 'ready'; target: string }
  | { state: 'starting' }

export const DEFAULT_PREVIEW_COMMAND = ['node_modules/.bin/vite', 'dev', '--host', '0.0.0.0', '--port', '5173', '--strictPort']
const PREVIEW_LABEL = 'dig.preview'

export interface PreviewManagerOptions {
  cli: DockerCli
  network: string
  image?: string
  limits?: SandboxLimits
  idleMs?: number
  now?: () => number
  /** TCP readiness probe; injectable for tests. */
  probe?: (host: string, port: number) => Promise<boolean>
}

function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

export function containerName(id: string) {
  return `dig-preview-${id}`
}

export function createPreviewManager(options: PreviewManagerOptions) {
  const { cli, network } = options
  const now = options.now ?? Date.now
  const idleMs = options.idleMs ?? 30 * 60_000
  const probe = options.probe ?? tcpProbe
  const lastUsed = new Map<string, number>()
  const starting = new Map<string, Promise<void>>()
  let networkReady: Promise<void> | null = null

  function ensureNetwork() {
    networkReady ??= (async () => {
      const exists = await cli.run(['network', 'inspect', network], { timeoutMs: 30_000 })
      if (exists.code !== 0) {
        await docker(cli, ['network', 'create', '--internal', '--label', `${PREVIEW_LABEL}=1`, network])
      } else if (!/"Internal":\s*true/.test(exists.stdout)) {
        throw new DockerError(`network ${network} exists but is not internal`)
      }
    })().catch((error) => {
      networkReady = null
      throw error
    })
    return networkReady
  }

  async function start(project: PreviewProject) {
    await ensureNetwork()
    const owner = await ownerOf(project.workdir)
    const args = runArgs({
      name: containerName(project.id),
      workdir: owner.path,
      user: owner.user,
      network: { internal: network },
      env: project.env,
      labels: { [PREVIEW_LABEL]: project.id },
      limits: options.limits,
      image: options.image,
      detach: true,
      command: project.command ?? DEFAULT_PREVIEW_COMMAND,
    })
    const result = await cli.run(args, { timeoutMs: 60_000 })
    // A concurrent start may have won the name; that container is just as good.
    if (result.code !== 0 && !/already in use/.test(result.stderr)) {
      throw new DockerError(`preview ${project.id} failed to start: ${result.stderr.trim().slice(0, 300)}`)
    }
  }

  /** Returns the upstream when the dev server accepts connections; starts it if needed. */
  async function ensure(project: PreviewProject): Promise<PreviewState> {
    if (!isProjectId(project.id)) throw new DockerError(`invalid project id: ${project.id}`)
    lastUsed.set(project.id, now())
    const port = project.port ?? 5173
    const ip = await containerIp(cli, containerName(project.id), network)
    if (ip) {
      return (await probe(ip, port)) ? { state: 'ready', target: `http://${ip}:${port}` } : { state: 'starting' }
    }
    if (!starting.has(project.id)) {
      const pending = start(project).finally(() => starting.delete(project.id))
      starting.set(project.id, pending)
      await pending
    } else {
      await starting.get(project.id)
    }
    return { state: 'starting' }
  }

  async function stop(id: string) {
    lastUsed.delete(id)
    await cli.run(['rm', '-f', containerName(id)], { timeoutMs: 30_000 })
  }

  /** Stops previews idle for longer than idleMs. Returns the stopped ids. */
  async function reap(): Promise<string[]> {
    const listed = await docker(cli, ['ps', '--filter', `label=${PREVIEW_LABEL}`, '--format', `{{.Label "${PREVIEW_LABEL}"}}`])
    const stopped: string[] = []
    for (const id of listed.split('\n').filter(Boolean)) {
      if (now() - (lastUsed.get(id) ?? 0) > idleMs) {
        await stop(id)
        stopped.push(id)
      }
    }
    return stopped
  }

  return { ensure, stop, reap, ensureNetwork }
}

export type PreviewManager = ReturnType<typeof createPreviewManager>
