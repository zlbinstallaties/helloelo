import path from 'node:path'
import type { Prompts } from '../install/prompts.ts'
import type { RunOptions, RunResult, Sys, WriteOptions } from '../install/sys.ts'

/** A small pretend server: files, a few commands and what is running. Records everything that was done. */
export interface Call {
  cmd: string
  args: string[]
  user?: string
}

export const ORIGINAL_CADDYFILE = `{
	email beheer@example.nl
}

odoo20.srv1938209.hstgr.cloud {
	reverse_proxy 127.0.0.1:18069
}
`

export const CADDY_UNIT = `[Service]
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
`

export interface FakeOptions {
  caddyValidates?: () => boolean
  caddyReloads?: () => boolean
  /** HTTP status the Odoo site answers with, per call (before and after the change). */
  odooStatus?: () => number | null
  isRoot?: boolean
  noCaddy?: boolean
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
  const writes: Array<{ file: string; mode?: number; owner?: string }> = []
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
  if (!options.noCaddy) {
    files.set('/etc/caddy/Caddyfile', { content: ORIGINAL_CADDYFILE })
  }
  for (const [file, content] of Object.entries(options.files ?? {})) files.set(file, { content })

  const result = (stdout = '', code = 0, stderr = ''): RunResult => ({ code, stdout, stderr })

  async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    calls.push({ cmd, args, user: opts.user })
    switch (cmd) {
      case 'id':
        if (args[0] === '-u' && args.length === 1) return result(options.isRoot === false ? '1000\n' : '0\n')
        return users.has(args[1]) ? result('999\n') : result('', 1, 'no such user')
      case 'sh':
        return args[1] === 'command -v node' ? result('/usr/bin/node\n') : result('', 1)
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
      for (const [file, content] of Object.entries(options.repoFiles ?? {})) files.set(`${target}/${file}`, { content })
      return result()
    }
    return result() // fetch, merge
  }

  function docker(args: string[]): RunResult {
    if (options.noDocker) return result('', 127, 'docker: not found')
    const [verb, ...rest] = args
    if (verb === 'info') return result('ok')
    if (verb === 'compose') {
      if (rest[0] === 'version') return result('Docker Compose version v5.3.1')
      if (rest.includes('up')) {
        containers.set('dig-platform-odoo-gateway-1', { labels: ['com.docker.compose.project=dig-platform', 'com.docker.compose.service=odoo-gateway'] })
        return result()
      }
      if (rest.includes('down')) {
        containers.delete('dig-platform-odoo-gateway-1')
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
    if (verb === 'cat') return name === 'caddy' && !options.noCaddy ? result(CADDY_UNIT) : result('', 1, 'No files found')
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
      for (const key of [...files.keys()]) if (key === file || key.startsWith(`${file}/`)) files.delete(key)
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
