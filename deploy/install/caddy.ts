import type { RunResult, Sys } from './sys.ts'
import { CADDY_BEGIN, CADDY_END } from './templates.ts'

/*
 * The Caddy that already serves this machine: where it is, how to check a configuration with it, and
 * how to make it load a changed one. Two situations are supported:
 *
 *  - a Caddy in a Docker container on the host network, with its Caddyfile bind-mounted from the host
 *    (this is what the Hostinger Odoo template sets up)
 *  - a Caddy that runs as a systemd service
 *
 * Our hostnames go into the Caddyfile as one marked block, so removing them again is exact.
 */

export type CaddyTarget =
  | { kind: 'docker'; container: string; name: string; config: string; containerConfig: string; adminOff: boolean }
  | { kind: 'systemd'; binary: string; config: string; adminOff: boolean }

const ADMIN_OFF = /^\s*admin\s+off\b/m

export function parseConfigFlag(args: string): string {
  const parts = args.trim().split(/\s+/)
  const joined = parts.find((p) => p.startsWith('--config='))
  if (joined) return joined.slice('--config='.length)
  const flag = parts.indexOf('--config')
  return flag >= 0 && parts[flag + 1] ? parts[flag + 1] : '/etc/caddy/Caddyfile'
}

/** systemd's cgroup path ("docker-<id>.scope") or the cgroupfs one ("/docker/<id>"). */
export function containerIdFromCgroup(text: string): string | null {
  return /docker-([0-9a-f]{64})\.scope/.exec(text)?.[1] ?? /\/docker\/([0-9a-f]{64})/.exec(text)?.[1] ?? null
}

interface Inspected {
  Name?: string
  HostConfig?: { NetworkMode?: string }
  Mounts?: Array<{ Source?: string; Destination?: string }>
}

export async function discover(sys: Sys, problems: string[]): Promise<CaddyTarget | null> {
  const found = await sys.run('pgrep', ['-o', '-x', 'caddy'])
  const pid = found.code === 0 ? found.stdout.trim().split('\n')[0] : ''
  if (!pid) {
    problems.push('Er draait geen Caddy. Dit script haakt aan op de Caddy die al op poort 80/443 draait en start zelf geen webserver.')
    return null
  }
  const args = (await sys.run('ps', ['-o', 'args=', '-p', pid])).stdout
  const containerConfig = parseConfigFlag(args)
  const containerId = containerIdFromCgroup((await sys.read(`/proc/${pid}/cgroup`)) ?? '')

  if (containerId) {
    const inspected = await sys.run('docker', ['inspect', containerId])
    let info: Inspected | undefined
    try {
      info = (JSON.parse(inspected.stdout) as Inspected[])[0]
    } catch {
      info = undefined
    }
    if (!info) {
      problems.push(`Caddy draait in een container (${containerId.slice(0, 12)}), maar die is niet te inspecteren.`)
      return null
    }
    const name = (info.Name ?? containerId.slice(0, 12)).replace(/^\//, '')
    if (info.HostConfig?.NetworkMode !== 'host') {
      problems.push(`Caddy (${name}) draait niet op het hostnetwerk. Alleen een Caddy op het hostnetwerk kan de diensten op localhost bereiken; die opzet wordt nog niet ondersteund.`)
      return null
    }
    const mounts = info.Mounts ?? []
    const exact = mounts.find((m) => m.Destination === containerConfig)
    const parent = mounts.find((m) => m.Destination && containerConfig.startsWith(`${m.Destination}/`))
    const host = exact?.Source ?? (parent ? `${parent.Source}${containerConfig.slice(parent.Destination!.length)}` : null)
    if (!host) {
      problems.push(`Het configuratiebestand van Caddy (${containerConfig}) staat niet op de server: het is niet vanuit de host gemonteerd in ${name}.`)
      return null
    }
    const content = await sys.read(host)
    if (content === null) {
      problems.push(`Het configuratiebestand ${host} van Caddy (${name}) is niet te lezen.`)
      return null
    }
    return { kind: 'docker', container: containerId, name, config: host, containerConfig, adminOff: ADMIN_OFF.test(content) }
  }

  const binaryArg = args.trim().split(/\s+/)[0] ?? ''
  const binary = binaryArg.startsWith('/') ? binaryArg : ((await sys.run('sh', ['-c', 'command -v caddy'])).stdout.trim() || 'caddy')
  const content = await sys.read(containerConfig)
  if (content === null || /\.json$/i.test(containerConfig)) {
    problems.push(`Caddy gebruikt ${containerConfig}; alleen een gewoon Caddyfile dat op de server staat wordt ondersteund.`)
    return null
  }
  return { kind: 'systemd', binary, config: containerConfig, adminOff: ADMIN_OFF.test(content) }
}

export function describe(target: CaddyTarget) {
  return target.kind === 'docker'
    ? `container ${target.name} (hostnetwerk), bestand ${target.config}${target.adminOff ? ', beheer-API uit: herladen via een signaal' : ''}`
    : `${target.binary}, bestand ${target.config}`
}

/** Checks a configuration with the Caddy that will load it (same version, same modules). */
export function validate(sys: Sys, target: CaddyTarget): Promise<RunResult> {
  return target.kind === 'docker'
    ? sys.run('docker', ['exec', target.container, 'caddy', 'validate', '--config', target.containerConfig, '--adapter', 'caddyfile'])
    : sys.run(target.binary, ['validate', '--config', target.config, '--adapter', 'caddyfile'])
}

export interface Reloaded {
  ok: boolean
  detail: string
}

/**
 * Makes Caddy load the changed file without interrupting what it serves. Caddy keeps its old
 * configuration when the new one is refused. For the container the result is read from Caddy's own log.
 */
export async function reload(sys: Sys, target: CaddyTarget): Promise<Reloaded> {
  if (target.kind === 'systemd') {
    const result = await sys.run('systemctl', ['reload', 'caddy'])
    return { ok: result.code === 0, detail: (result.stderr || result.stdout).trim().slice(0, 600) }
  }
  const since = sys.now().toISOString()
  const signal = await sys.run('docker', ['kill', '--signal=USR1', target.container])
  if (signal.code !== 0) return { ok: false, detail: signal.stderr.trim().slice(0, 600) }
  for (let i = 0; i < 20; i++) {
    await sys.sleep(1000)
    const logs = await sys.run('docker', ['logs', '--since', since, target.container])
    const text = `${logs.stdout}\n${logs.stderr}`
    if (text.includes('successfully reloaded config')) return { ok: true, detail: 'Caddy bevestigt het herladen' }
    const failed = text.split('\n').find((line) => line.includes('failed to reload config'))
    if (failed) return { ok: false, detail: failed.slice(0, 600) }
  }
  return { ok: false, detail: 'Caddy bevestigde het herladen niet binnen 20 seconden' }
}

/** Our block, put at the end of the Caddyfile; an earlier version of the block is replaced. */
export function withBlock(main: string, block: string): string {
  const base = withoutBlock(main)
  const gap = base === '' ? '' : base.endsWith('\n') ? '\n' : '\n\n'
  return `${base}${gap}${block}`
}

/** The exact inverse of withBlock: removes the block and the blank line that was added before it. */
export function withoutBlock(main: string): string {
  const begin = main.indexOf(CADDY_BEGIN)
  if (begin < 0) return main
  const endMark = main.indexOf(CADDY_END, begin)
  if (endMark < 0) return main
  let before = main.slice(0, begin)
  if (before.endsWith('\n\n')) before = before.slice(0, -1)
  const after = main.slice(endMark + CADDY_END.length).replace(/^\n/, '')
  return before + after
}
