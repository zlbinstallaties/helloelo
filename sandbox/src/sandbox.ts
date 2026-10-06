import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { docker, DockerError, type DockerCli } from './docker.ts'

/*
 * Hardened containers for running project code (install, build, tests,
 * preview). A container sees one project directory at /work and nothing else:
 *
 *  - no Odoo key, no API keys: only the env passed explicitly
 *  - runs as the owner of the project directory, never as root
 *  - read-only root filesystem, /tmp as tmpfs
 *  - all capabilities dropped, no-new-privileges, init process
 *  - memory, swap, CPU and process limits
 *  - network "none" unless a step needs more ("registry" for installs,
 *    or a named internal network for previews)
 */

export const SANDBOX_IMAGE = 'dig-sandbox:1'
export const SANDBOX_LABEL = 'dig.sandbox'

export type SandboxNetwork = 'none' | 'registry' | { internal: string }

export interface SandboxLimits {
  memory: string
  cpus: string
  pids: number
  tmpSize: string
}

export const DEFAULT_LIMITS: SandboxLimits = { memory: '2g', cpus: '2', pids: 512, tmpSize: '512m' }

export interface ContainerSpec {
  name: string
  workdir: string
  user: string
  network: SandboxNetwork
  env?: Record<string, string>
  labels?: Record<string, string>
  limits?: SandboxLimits
  image?: string
  detach?: boolean
  /**
   * A container that is meant to keep running (a published app): restarted by Docker after a
   * crash or reboot, not removed on exit, and not matched by the sandbox cleanup label.
   */
  persistent?: boolean
  /** Mount the project directory read-only (published apps never write to their own files). */
  readOnlyWorkdir?: boolean
  /** Extra read-only file mounts (e.g. a proxy CA bundle). */
  readOnlyFiles?: Record<string, string>
  command: readonly string[]
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const SECRET_ENV = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/
const ALLOWED_SECRET_ENV = new Set(['DIG_GATEWAY_TOKEN'])

export function runArgs(spec: ContainerSpec): string[] {
  if (!NAME_PATTERN.test(spec.name)) throw new DockerError(`invalid container name: ${spec.name}`)
  if (!/^[1-9][0-9]*:[0-9]+$/.test(spec.user)) throw new DockerError('sandbox must run as a non-root uid:gid')
  const limits = spec.limits ?? DEFAULT_LIMITS
  const network =
    spec.network === 'none' ? 'none' : spec.network === 'registry' ? 'bridge' : spec.network.internal
  const args = [
    'run',
    ...(spec.detach ? ['-d'] : []),
    ...(spec.persistent ? ['--restart', 'unless-stopped'] : ['--rm']),
    '--init',
    '--name', spec.name,
    '--network', network,
    '--user', spec.user,
    '--read-only',
    '--tmpfs', `/tmp:rw,exec,nosuid,size=${limits.tmpSize}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(limits.pids),
    '--memory', limits.memory,
    '--memory-swap', limits.memory,
    '--cpus', limits.cpus,
    '--volume', `${spec.workdir}:/work:${spec.readOnlyWorkdir ? 'ro' : 'rw'}`,
    '--workdir', '/work',
    '--label', `${SANDBOX_LABEL}=${spec.persistent ? 'persistent' : '1'}`,
    '--env', 'HOME=/tmp',
    '--env', 'CI=1',
    '--env', 'NO_COLOR=1',
  ]
  for (const [source, target] of Object.entries(spec.readOnlyFiles ?? {})) {
    if (source.includes(',') || target.includes(',') || !target.startsWith('/etc/')) {
      throw new DockerError(`invalid read-only mount: ${target}`)
    }
    args.push('--mount', `type=bind,source=${source},target=${target},readonly`)
  }
  for (const [key, value] of Object.entries(spec.labels ?? {})) args.push('--label', `${key}=${value}`)
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (!ENV_NAME.test(key)) throw new DockerError(`invalid env name: ${key}`)
    // Credentials never enter a sandbox, except the scoped gateway token for previews.
    if (SECRET_ENV.test(key) && !ALLOWED_SECRET_ENV.has(key)) throw new DockerError(`secret env not allowed in sandbox: ${key}`)
    args.push('--env', `${key}=${value}`)
  }
  args.push(spec.image ?? SANDBOX_IMAGE, ...spec.command)
  return args
}

/** uid:gid of the directory owner; the container writes files as that user. */
export async function ownerOf(workdir: string): Promise<{ path: string; user: string }> {
  const real = await realpath(workdir)
  const info = await stat(real)
  if (!info.isDirectory()) throw new DockerError(`not a directory: ${workdir}`)
  if (info.uid === 0) throw new DockerError('project directory must not be owned by root (the sandbox never runs as root)')
  return { path: real, user: `${info.uid}:${info.gid}` }
}

export interface ExecResult {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  output: string
}

const MAX_OUTPUT_CHARS = 20_000

function tail(text: string) {
  return text.length > MAX_OUTPUT_CHARS ? `[... ingekort ...]\n${text.slice(-MAX_OUTPUT_CHARS)}` : text
}

export interface SandboxOptions {
  cli: DockerCli
  image?: string
  limits?: SandboxLimits
  /** CA bundle for a TLS-intercepting proxy; only mounted for registry access. */
  caBundle?: string
}

const CA_TARGET = '/etc/dig-ca.pem'

export function createSandbox(options: SandboxOptions) {
  const { cli } = options

  /** Runs one command to completion in a fresh container. */
  async function exec(
    workdir: string,
    command: readonly string[],
    opts: { network?: SandboxNetwork; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<ExecResult> {
    const owner = await ownerOf(workdir)
    const name = `dig-exec-${randomBytes(6).toString('hex')}`
    const timeoutMs = opts.timeoutMs ?? 300_000
    const network = opts.network ?? 'none'
    const withCa = network === 'registry' && options.caBundle
    const args = runArgs({
      name,
      workdir: owner.path,
      user: owner.user,
      network,
      env: withCa ? { ...opts.env, NODE_EXTRA_CA_CERTS: CA_TARGET } : opts.env,
      readOnlyFiles: withCa ? { [options.caBundle!]: CA_TARGET } : undefined,
      limits: options.limits,
      image: options.image,
      command,
    })
    const result = await cli.run(args, { timeoutMs })
    if (result.timedOut) {
      // Killing the CLI does not stop the container; remove it explicitly.
      await cli.run(['rm', '-f', name], { timeoutMs: 30_000 })
    }
    return {
      ok: result.code === 0 && !result.timedOut,
      exitCode: result.code,
      timedOut: result.timedOut,
      output: tail(`${result.stdout}${result.stderr}`.trim()) || '(geen uitvoer)',
    }
  }

  /**
   * Installs dependencies from the lockfile. Needs the registry, so it runs on
   * the bridge network, but with lifecycle scripts disabled: nothing from the
   * downloaded packages executes during install.
   */
  function install(workdir: string, timeoutMs = 600_000) {
    return exec(workdir, ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], { network: 'registry', timeoutMs })
  }

  return { exec, install }
}

export type Sandbox = ReturnType<typeof createSandbox>

/** Removes leftover sandbox containers (e.g. after a crash). */
export async function removeAllSandboxes(cli: DockerCli) {
  const ids = await docker(cli, ['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}=1`])
  if (ids) await docker(cli, ['rm', '-f', ...ids.split('\n')])
}
