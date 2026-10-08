import path from 'node:path'
import type { Prompts } from '../install/prompts.ts'
import type { RunOptions, RunResult, Sys, WriteOptions } from '../install/sys.ts'

/** A small pretend server: files, a few commands and what is running. Records everything that was done. */
export interface Call {
  cmd: string
  args: string[]
  user?: string
}

/** What the Hostinger Odoo template puts in the Caddyfile: the admin API is switched off. */
export const ORIGINAL_CADDYFILE = `{
    admin off
}
odoo20.srv1938209.hstgr.cloud {
    header X-Robots-Tag "noindex, nofollow, noarchive"
    reverse_proxy 127.0.0.1:18069
}
`

export const CONTAINER_ID = 'cddde94abb21ec1faa4f852f5bf647896d53ce6ec33d02eff71054261c75ccba'
export const DOCKER_CADDYFILE = '/opt/odoo20-test/Caddyfile'
export const SYSTEMD_CADDYFILE = '/etc/caddy/Caddyfile'

export interface FakeOptions {
  /** How Caddy runs on the server. Default: in a container, like on the Hostinger VPS. */
  caddy?: 'docker' | 'systemd' | 'none'
  /** For a container: its network mode, and whether the Caddyfile is mounted from the host. */
  caddyNetwork?: string
  caddyMounted?: boolean
  caddyValidates?: () => boolean
  caddyReloads?: () => boolean
  /** The container never says whether it reloaded (nothing in its log). */
  caddySilent?: boolean
  /** HTTP status the Odoo site answers with, per call (before and after the change). */
  odooStatus?: () => number | null
  isRoot?: boolean
  noDocker?: boolean
  otherContainers?: string[]
  files?: Record<string, string>
  /** What the installer's own checkout contains (from the real repository files). */
  repoFiles?: Record<string, string>
}

export function fakeServer(options: FakeOptions = {}) {
  const files = new Map<string, { content: string; mode?: number; owner?: string }>()
  const dirs = new Set<string>()
  const calls: Call[] = []
  const writes: Array<{ file: string; mode?: number; owner?: string; inPlace?: boolean }> = []
  const removed: string[] = []
  const active = new Set<string>()
  const enabled = new Set<string>()
  const containers = new Map<string, { labels: string[] }>()
  for (const name of options.otherContainers ?? ['odoo20-test-odoo-1', 'odoo20-test-db-1', 'dig-builder-test-builder-1']) containers.set(name, { labels: [] })
  const networks = new Map<string, { internal: boolean }>([['bridge', { internal: false }]])
  const images = new Set<string>()
  const users = new Set<string>()
  let validations = 0
  let reloads = 0
  let odooCalls = 0
  const log: string[] = []
  const clock = { ms: Date.parse('2026-10-06T10:00:00Z') }

  files.set('/etc/os-release', { content: 'PRETTY_NAME="Ubuntu 24.04.4 LTS"\n' })
  const caddyKind = options.caddy ?? 'docker'
  const caddyFile = caddyKind === 'docker' ? DOCKER_CADDYFILE : SYSTEMD_CADDYFILE
  if (caddyKind !== 'none') files.set(caddyFile, { content: ORIGINAL_CADDYFILE })
  if (caddyKind === 'docker') files.set('/proc/1499/cgroup', { content: `0::/system.slice/docker-${CONTAINER_ID}.scope\n` })
  let lastReload: 'ok' | 'failed' | null = null
  let signals = 0
  for (const [file, content] of Object.entries(options.files ?? {})) files.set(file, { content })

  const result = (stdout = '', code = 0, stderr = ''): RunResult => ({ code, stdout, stderr })

  async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    calls.push({ cmd, args, user: opts.user })
    switch (cmd) {
      case 'id':
        if (args[0] === '-u' && args.length === 1) return result(options.isRoot === false ? '1000\n' : '0\n')
        return users.has(args[1]) ? result('999\n') : result('', 1, 'no such user')
      case 'sh':
        if (args[1] === 'command -v node') return result('/usr/bin/node\n')
        return args[1] === 'command -v caddy' ? result('/usr/bin/caddy\n') : result('', 1)
      case 'pgrep':
        return caddyKind === 'none' ? result('', 1) : result('1499\n')
      case 'ps':
        return caddyKind === 'docker'
          ? result('caddy run --config /etc/caddy/Caddyfile --adapter caddyfile\n')
          : result('/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile\n')
      case 'git':
        return git(args)
      case 'curl':
        return result('187.7.16.218')
      case 'getent':
        return result(`187.7.16.218 STREAM ${args[1]}\n`)
      case 'useradd':
        users.add(args.at(-1)!)
        return result()
      case 'usermod':
      case 'userdel':
        if (cmd === 'userdel') users.delete(args.at(-1)!)
        return result()
      case 'chown':
        return result()
      case 'node':
        // sandbox cli: "install <dir>" leaves node_modules behind
        if (args.includes('install')) {
          dirs.add(path.join(args.at(-1)!, 'node_modules'))
          files.set(path.join(args.at(-1)!, 'node_modules/.installed'), { content: '' })
        }
        return result()
      case 'docker':
        return docker(args)
      case 'systemctl':
        return systemctl(args)
      case 'journalctl':
        return result('Oct 06 dig-preview[1]: boom\n')
      case '/usr/bin/caddy':
        validations += 1
        return (options.caddyValidates?.() ?? true) ? result('Valid configuration') : result('', 1, 'Error: adapting config: unrecognized directive')
      default:
        return result('', 127, `unknown command ${cmd}`)
    }
  }

  function git(args: string[]): RunResult {
    if (args[0] === 'clone') {
      const target = args.at(-1)!
      dirs.add(target)
      files.set(`${target}/.git/HEAD`, { content: 'ref: refs/heads/master\n' })
      if (target === '/srv/dig-builder/app') files.set(`${target}/agent/bun.lock`, { content: '{"lockfileVersion": 1}\n' })
      for (const [file, content] of Object.entries(options.repoFiles ?? {})) files.set(`${target}/${file}`, { content })
      return result()
    }
    return result() // fetch, merge
  }

  function docker(args: string[]): RunResult {
    if (options.noDocker) return result('', 127, 'docker: not found')
    const [verb, ...rest] = args
    if (verb === 'info') return result('ok')
    if (verb === 'inspect') {
      if (!rest[0]?.startsWith(CONTAINER_ID.slice(0, 12))) return result('', 1, 'No such object')
      return result(JSON.stringify([{
        Name: '/odoo20-test-proxy-1',
        HostConfig: { NetworkMode: options.caddyNetwork ?? 'host' },
        Config: { Env: ['SECRET_FROM_ENV=must-never-be-printed'] },
        Mounts: options.caddyMounted === false ? [] : [{ Type: 'bind', Source: DOCKER_CADDYFILE, Destination: '/etc/caddy/Caddyfile', RW: false }],
      }]))
    }
    if (verb === 'exec') {
      validations += 1
      return (options.caddyValidates?.() ?? true) ? result('Valid configuration') : result('', 1, 'Error: adapting config: unrecognized directive')
    }
    if (verb === 'kill') {
      reloads += 1
      signals += 1
      lastReload = options.caddySilent ? null : (options.caddyReloads?.() ?? true) ? 'ok' : 'failed'
      return result(rest.at(-1)!)
    }
    if (verb === 'logs') {
      if (lastReload === 'ok') return result('', 0, '{"level":"info","msg":"successfully reloaded config from file","signal":"SIGUSR1"}\n')
      if (lastReload === 'failed') return result('', 0, '{"level":"error","msg":"failed to reload config from file","signal":"SIGUSR1","error":"adapting config using caddyfile: unrecognized directive"}\n')
      return result()
    }
    if (verb === 'compose') {
      if (rest[0] === 'version') return result('Docker Compose version v5.3.1')
      if (rest.includes('up')) {
        containers.set('dig-platform-odoo-gateway-1', { labels: ['com.docker.compose.project=dig-platform', 'com.docker.compose.service=odoo-gateway'] })
        networks.set('dig-platform_default', { internal: false })
        return result()
      }
      if (rest.includes('down')) {
        // Like the real thing: without the variables the compose file cannot even be read.
        if (!rest.includes('--env-file')) return result('', 1, 'required variable ODOO_BASE_URL is missing a value')
        containers.delete('dig-platform-odoo-gateway-1')
        networks.delete('dig-platform_default')
        return result()
      }
    }
    if (verb === 'network') {
      if (rest[0] === 'inspect' && rest[1] === 'bridge') return result('172.17.0.1\n')
      if (rest[0] === 'inspect') return networks.has(rest[1]) ? result(`${networks.get(rest[1])!.internal}\n`) : result('', 1, 'No such network')
      if (rest[0] === 'create') {
        networks.set(rest.at(-1)!, { internal: rest.includes('--internal') })
        return result()
      }
      if (rest[0] === 'rm') {
        networks.delete(rest[1])
        return result()
      }
    }
    if (verb === 'image') return images.has(rest[1]) ? result() : result('', 1, 'No such image')
    if (verb === 'build') {
      images.add(rest[rest.indexOf('-t') + 1])
      return result()
    }
    if (verb === 'ps') {
      const label = args[args.indexOf('--filter') + 1]?.replace('label=', '')
      const health = args.includes('health=healthy')
      const names = [...containers].filter(([name, c]) => (health ? name.includes('odoo-gateway') : label ? c.labels.some((l) => l === label || l.startsWith(`${label}=`)) : true)).map(([n]) => n)
      return result(names.join('\n'))
    }
    if (verb === 'rm') {
      for (const name of rest.filter((a) => !a.startsWith('-'))) containers.delete(name)
      return result()
    }
    if (verb === 'rmi') {
      images.delete(rest[0])
      return result()
    }
    return result('', 1, `fake docker: unsupported ${args.join(' ')}`)
  }

  function systemctl(args: string[]): RunResult {
    const verb = args[0]
    const name = args.slice(1).find((a) => !a.startsWith('-')) ?? ''
    if (verb === 'cat') return result('', 1, 'No files found')
    if (verb === 'daemon-reload') return result()
    if (verb === 'enable') {
      enabled.add(name)
      return result()
    }
    if (verb === 'disable') {
      enabled.delete(name)
      active.delete(name)
      return result()
    }
    if (verb === 'restart') {
      active.add(name)
      return result()
    }
    if (verb === 'is-active') return active.has(name) ? result('active\n') : result('inactive\n', 3)
    if (verb === 'reload') {
      reloads += 1
      return (options.caddyReloads?.() ?? true) ? result() : result('', 1, 'Job for caddy.service failed')
    }
    return result()
  }

  const sys: Sys = {
    run,
    async read(file) {
      return files.get(file)?.content ?? null
    },
    async write(file, content, opts: WriteOptions = {}) {
      files.set(file, { content, ...opts })
      writes.push({ file, ...opts })
    },
    async exists(file) {
      return files.has(file) || dirs.has(file) || [...files.keys()].some((f) => f.startsWith(`${file}/`))
    },
    async mkdir(dir, opts: WriteOptions = {}) {
      dirs.add(dir)
      writes.push({ file: dir, ...opts })
    },
    async remove(file) {
      removed.push(file)
      for (const key of files.keys()) if (key === file || key.startsWith(`${file}/`)) files.delete(key)
      dirs.delete(file)
    },
    async http(url) {
      if (url.startsWith('https://odoo20.')) {
        odooCalls += 1
        return options.odooStatus ? options.odooStatus() : 200
      }
      return url.includes('/_dig/login') || url.endsWith('/') ? 200 : null
    },
    async sleep(ms) {
      clock.ms += ms
    },
    now: () => new Date(clock.ms),
    log: (message) => log.push(message),
  }

  return {
    sys, files, dirs, calls, writes, removed, active, enabled, containers, networks, images, users, log,
    caddyFile,
    get signals() { return signals },
    get validations() { return validations },
    get reloads() { return reloads },
    get odooCalls() { return odooCalls },
    text: (file: string) => files.get(file)?.content ?? null,
  }
}

export type Server = ReturnType<typeof fakeServer>

/** Answers questions from a script; fails the test when asked something unexpected. */
export function scriptedPrompts(answers: Array<string | boolean>) {
  const asked: string[] = []
  const said: string[] = []
  const queue = [...answers]
  const prompts: Prompts = {
    say: (message) => said.push(message),
    async ask(question, options = {}) {
      asked.push(question)
      const next = queue.shift()
      if (next === undefined) throw new Error(`unexpected question: ${question}`)
      return String(next) || options.default || ''
    },
    async confirm(question, defaultYes = false) {
      asked.push(question)
      const next = queue.shift()
      return typeof next === 'boolean' ? next : defaultYes
    },
  }
  return { prompts, asked, said, left: () => queue.length }
}
