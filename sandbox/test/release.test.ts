import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DockerCli, DockerResult } from '../src/docker.ts'
import { createLiveResolver, createPublisher, excerpt, type PublishError, type PublishConfig, type PublishPhase } from '../src/release.ts'

const NETWORK = 'dig-preview'
const CONFIG: PublishConfig = { build: ['bun', 'run', 'build'], start: ['bun', 'run', 'start'], port: 3000, healthPath: '/api/health', env: { DIG_GATEWAY_URL: 'http://odoo-gateway:8070', DIG_GATEWAY_TOKEN: 'tok' } }

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
}

async function repo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-pub-repo-'))
  git(dir, 'init', '-q', '-b', 'main')
  await writeFile(path.join(dir, 'package.json'), '{"name":"app"}\n')
  await mkdir(path.join(dir, 'src'))
  await writeFile(path.join(dir, 'src/version.txt'), 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'one')
  return {
    dir,
    commit(version: string) {
      execFileSync('sh', ['-c', `printf '${version}\\n' > src/version.txt`], { cwd: dir })
      git(dir, 'commit', '-q', '-am', version)
      return git(dir, 'rev-parse', 'HEAD')
    },
    head: () => git(dir, 'rev-parse', 'HEAD'),
  }
}

/** A tiny Docker: containers with an IP and a running flag, enough for the publisher. */
function fakeDocker() {
  const containers = new Map<string, { labels: string[]; ip: string; running: boolean; args: string[] }>()
  const calls: string[][] = []
  let next = 2
  const cli: DockerCli = {
    async run(args) {
      calls.push(args)
      const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '', timedOut: false })
      const value = (flag: string) => args[args.indexOf(flag) + 1]
      if (args[0] === 'run') {
        const name = value('--name')
        if (containers.has(name)) return { code: 125, stdout: '', stderr: 'name already in use', timedOut: false }
        const labels = args.flatMap((a, i) => (args[i - 1] === '--label' ? [a] : []))
        containers.set(name, { labels, ip: `10.0.0.${next++}`, running: true, args })
        return ok(`${name}-id\n`)
      }
      if (args[0] === 'rm') {
        containers.delete(args[2])
        return ok()
      }
      if (args[0] === 'inspect') {
        const c = containers.get(args[3])
        if (!c) return { code: 1, stdout: '', stderr: 'No such object', timedOut: false }
        return ok(args[2].includes('IPAddress') ? `${c.running ? c.ip : ''}|${c.running}` : String(c.running))
      }
      if (args[0] === 'ps') {
        const label = args[args.indexOf('--filter') + 1].replace('label=', '')
        return ok([...containers].filter(([, c]) => c.labels.includes(label)).map(([n]) => n).join('\n'))
      }
      if (args[0] === 'logs') return ok('boom: cannot find module\n')
      return ok()
    },
  }
  return { cli, containers, calls }
}

interface Env {
  workdir: string
  releasesDir: string
  docker: ReturnType<typeof fakeDocker>
  steps: string[]
  publisher: ReturnType<typeof createPublisher>
  src: Awaited<ReturnType<typeof repo>>
  healthy: Set<string>
  failBuild: { value: boolean; output?: string }
  failInstall: { value: boolean }
  clock: { ms: number }
  /** When set, every health check answers with this HTTP status. */
  probeStatus: { value: number | null }
}

async function setup(options: { keep?: number } = {}): Promise<Env> {
  const src = await repo()
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'dig-pub-rel-'))
  const docker = fakeDocker()
  const steps: string[] = []
  const healthy = new Set<string>()
  const failBuild: { value: boolean; output?: string } = { value: false }
  const failInstall = { value: false }
  const clock = { ms: Date.parse('2026-10-06T08:00:00Z') }
  const probeStatus: { value: number | null } = { value: null }
  const publisher = createPublisher({
    cli: docker.cli,
    releasesDir,
    network: NETWORK,
    keep: options.keep,
    now: () => new Date((clock.ms += 60_000)),
    readyTimeoutMs: 40,
    graceMs: 0,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    owner: async (dir) => ({ path: dir, user: '1000:1000' }),
    probe: async (url) => {
      steps.push(`probe ${url.replace(/10\.0\.0\.\d+/, '<ip>')}`)
      return probeStatus.value ?? (healthy.has(new URL(url).hostname) ? 200 : null)
    },
    sandbox: {
      async install(dir) {
        steps.push('install')
        assert.ok(existsSync(path.join(dir, 'package.json')), 'export is there before install')
        if (failInstall.value) return { ok: false, exitCode: 1, timedOut: false, output: 'registry unreachable' }
        await mkdir(path.join(dir, 'node_modules'), { recursive: true })
        return { ok: true, exitCode: 0, timedOut: false, output: '' }
      },
      async exec(dir, command, opts) {
        steps.push(`exec ${command.join(' ')} network=${opts?.network}`)
        if (failBuild.value) return { ok: false, exitCode: 1, timedOut: false, output: failBuild.output ?? 'vite: build failed on src/x.ts' }
        await mkdir(path.join(dir, 'dist'), { recursive: true })
        await writeFile(path.join(dir, 'dist/built.txt'), readFileSync(path.join(dir, 'src/version.txt')))
        return { ok: true, exitCode: 0, timedOut: false, output: '' }
      },
    },
  })
  // Every container that gets created answers its health check, unless a test removes it from the set.
  const originalRun = docker.cli.run.bind(docker.cli)
  docker.cli.run = async (args, opts) => {
    const result = await originalRun(args, opts)
    if (args[0] === 'run' && result.code === 0) healthy.add(docker.containers.get(args[args.indexOf('--name') + 1])!.ip)
    return result
  }
  return { workdir: src.dir, releasesDir, docker, steps, publisher, src, healthy, failBuild, failInstall, clock, probeStatus }
}

const current = (env: Env, id = 'dashboard') => JSON.parse(readFileSync(path.join(env.releasesDir, id, 'current.json'), 'utf8'))
const releaseDirs = (env: Env, id = 'dashboard') => readdirSync(path.join(env.releasesDir, id, 'releases')).sort()
const publish = (env: Env, phases?: PublishPhase[]) =>
  env.publisher.publish({ id: 'dashboard', workdir: env.workdir, ref: 'main', config: CONFIG, onPhase: phases ? (p) => phases.push(p) : undefined })

test('publish exports the commit, builds in the sandbox, starts a hardened container and moves the pointer', async () => {
  const env = await setup()
  await writeFile(path.join(env.workdir, 'src/version.txt'), 'uncommitted\n')
  await writeFile(path.join(env.workdir, 'untracked.txt'), 'x')
  const phases: PublishPhase[] = []
  const release = await publish(env, phases)

  assert.deepEqual(phases, ['export', 'install', 'build', 'start', 'check', 'switch'])
  assert.deepEqual(env.steps, ['install', 'exec bun run build network=none', 'probe http://<ip>:3000/api/health'])
  const app = path.join(env.releasesDir, 'dashboard/releases', release.id, 'app')
  assert.equal(readFileSync(path.join(app, 'src/version.txt'), 'utf8'), 'one\n', 'only committed content is published')
  assert.equal(readFileSync(path.join(app, 'dist/built.txt'), 'utf8'), 'one\n')
  assert.ok(!existsSync(path.join(app, '.git')) && !existsSync(path.join(app, 'untracked.txt')))
  assert.ok(!existsSync(path.join(app, '..', 'source.tar')))

  const pointer = current(env)
  assert.equal(pointer.commit, env.src.head())
  assert.equal(pointer.container, release.container)
  assert.equal(pointer.port, 3000)
  assert.equal(pointer.releaseId, release.id)
  assert.match(release.id, /^[a-z0-9]+-[0-9a-f]{7}$/)

  const args = env.docker.containers.get(release.container)!.args
  const flag = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
  assert.deepEqual(flag('--restart'), ['unless-stopped'])
  assert.ok(!args.includes('--rm'))
  assert.deepEqual(flag('--network'), [NETWORK])
  assert.deepEqual(flag('--volume'), [`${app}:/work:ro`])
  assert.deepEqual(flag('--user'), ['1000:1000'])
  assert.ok(args.includes('--read-only') && args.includes('no-new-privileges'))
  assert.ok(args.includes('PORT=3000') && args.includes('DIG_GATEWAY_TOKEN=tok') && args.includes('NODE_ENV=production'))
  assert.ok(flag('--label').includes('dig.live=dashboard') && flag('--label').includes('dig.sandbox=persistent'))
  assert.deepEqual(args.slice(-4), ['dig-sandbox:1', 'bun', 'run', 'start'])
  assert.ok(!JSON.stringify(readdirSync(path.join(env.releasesDir, 'dashboard'))).includes('tok'))
  assert.ok(!readFileSync(path.join(env.releasesDir, 'dashboard/current.json'), 'utf8').includes('tok'), 'no secrets on disk')
})

test('a second publish switches over, removes the old container and keeps the old release for rolling back', async () => {
  const env = await setup()
  const first = await publish(env)
  env.src.commit('two')
  const second = await publish(env)
  assert.notEqual(first.id, second.id)
  assert.equal(current(env).releaseId, second.id)
  assert.deepEqual([...env.docker.containers.keys()], [second.container], 'only the live container runs')
  assert.equal(releaseDirs(env).length, 2)
  const list = await env.publisher.list('dashboard')
  assert.deepEqual(list.releases.map((r) => r.id), [second.id, first.id], 'newest first')
  assert.equal(list.current?.releaseId, second.id)
})

test('publishing the live commit again is refused', async () => {
  const env = await setup()
  await publish(env)
  await assert.rejects(publish(env), (e: PublishError) => e.code === 'already_current')
  assert.equal(releaseDirs(env).length, 1)
})

test('a failing install or build never touches the live version and leaves nothing behind', async () => {
  const env = await setup()
  const live = await publish(env)
  env.src.commit('two')

  env.failBuild.value = true
  await assert.rejects(publish(env), (e: PublishError) => e.code === 'build_failed' && /vite: build failed/.test(e.message))
  env.failBuild.value = false
  env.failInstall.value = true
  await assert.rejects(publish(env), (e: PublishError) => e.code === 'build_failed' && /registry unreachable/.test(e.message))

  assert.equal(current(env).releaseId, live.id)
  assert.deepEqual([...env.docker.containers.keys()], [live.container])
  assert.deepEqual(releaseDirs(env), [live.id])
})

test('a new version that does not answer is removed, and the old one keeps serving', async () => {
  const env = await setup()
  const live = await publish(env)
  env.src.commit('two')
  const run = env.docker.cli.run.bind(env.docker.cli)
  env.docker.cli.run = async (args, opts) => {
    const result = await run(args, opts)
    // The new container comes up but never gets healthy.
    if (args[0] === 'run') env.healthy.delete(env.docker.containers.get(args[args.indexOf('--name') + 1])!.ip)
    return result
  }
  await assert.rejects(publish(env), (e: PublishError) => e.code === 'not_ready' && /cannot find module/.test(e.message))
  assert.equal(current(env).releaseId, live.id)
  assert.deepEqual([...env.docker.containers.keys()], [live.container])
  assert.deepEqual(releaseDirs(env), [live.id])
})

test('a version whose health check answers 5xx never goes live, and the message names the status', async () => {
  const env = await setup()
  const live = await publish(env)
  env.src.commit('two')
  env.probeStatus.value = 503
  await assert.rejects(publish(env), (e: PublishError) => e.code === 'not_ready' && /\/api\/health antwoordde met status 503/.test(e.message))
  assert.equal(current(env).releaseId, live.id)
  assert.deepEqual([...env.docker.containers.keys()], [live.container])
  env.probeStatus.value = 404
  const accepted = await publish(env)
  assert.equal(current(env).releaseId, accepted.id, 'a 404 on the health path still means the app answers')
})

test('a container that exits at once is reported without waiting for the timeout', async () => {
  const env = await setup()
  const run = env.docker.cli.run.bind(env.docker.cli)
  env.docker.cli.run = async (args, opts) => {
    const result = await run(args, opts)
    if (args[0] === 'run') {
      const c = env.docker.containers.get(args[args.indexOf('--name') + 1])!
      c.running = false
    }
    return result
  }
  const started = Date.now()
  await assert.rejects(publish(env), (e: PublishError) => e.code === 'not_ready')
  assert.ok(Date.now() - started < 1000)
  assert.ok(!existsSync(path.join(env.releasesDir, 'dashboard/current.json')))
})

test('rollback goes to the previous release, or to a chosen one, and starts its container', async () => {
  const env = await setup()
  const one = await publish(env)
  env.src.commit('two')
  const two = await publish(env)
  env.src.commit('three')
  const three = await publish(env)

  const back = await env.publisher.rollback({ id: 'dashboard', config: CONFIG })
  assert.equal(back.id, two.id)
  assert.equal(current(env).releaseId, two.id)
  assert.deepEqual([...env.docker.containers.keys()], [two.container])

  const chosen = await env.publisher.rollback({ id: 'dashboard', config: CONFIG, releaseId: one.id })
  assert.equal(chosen.id, one.id)
  assert.equal(current(env).commit, one.commit)

  await assert.rejects(env.publisher.rollback({ id: 'dashboard', config: CONFIG, releaseId: one.id }), (e: PublishError) => e.code === 'already_current')
  await assert.rejects(env.publisher.rollback({ id: 'dashboard', config: CONFIG, releaseId: 'zzzz-0000000' }), (e: PublishError) => e.code === 'unknown_release')
  await assert.rejects(env.publisher.rollback({ id: 'dashboard', config: CONFIG }), (e: PublishError) => e.code === 'no_release', 'nothing older than the first release')
  assert.ok(three.id)
})

test('restart brings the current release back when its container is gone', async () => {
  const env = await setup()
  const live = await publish(env)
  env.docker.containers.clear()
  const again = await env.publisher.restart({ id: 'dashboard', config: CONFIG })
  assert.equal(again.id, live.id)
  assert.deepEqual([...env.docker.containers.keys()], [live.container])
  await assert.rejects(env.publisher.restart({ id: 'nothing-here', config: CONFIG }), (e: PublishError) => e.code === 'no_release')
})

test('only the newest releases are kept, and never the live one', async () => {
  const env = await setup({ keep: 2 })
  const one = await publish(env)
  env.src.commit('two')
  const two = await publish(env)
  env.src.commit('three')
  const three = await publish(env)
  assert.deepEqual(releaseDirs(env).sort(), [three.id, two.id].sort())
  assert.ok(!releaseDirs(env).includes(one.id))

  // Roll back to the older one, then publish again: the live (older) release must survive pruning.
  await env.publisher.rollback({ id: 'dashboard', config: CONFIG, releaseId: two.id })
  env.src.commit('four')
  const four = await publish(env)
  assert.ok(releaseDirs(env).includes(four.id))
  assert.equal(current(env).releaseId, four.id)
})

test('two publishes at once for one project: the second is refused', async () => {
  const env = await setup()
  const first = publish(env)
  await assert.rejects(publish(env), (e: PublishError) => e.code === 'publish_busy')
  await first
})

test('bad project ids and refs are refused before anything runs', async () => {
  const env = await setup()
  for (const id of ['dashboard-live', '../x', 'Dash', '']) {
    await assert.rejects(env.publisher.publish({ id, workdir: env.workdir, ref: 'main', config: CONFIG }), (e: PublishError) => e.code === 'invalid_project', id)
  }
  for (const ref of ['--output=/tmp/x', '-h', 'a b', 'main;rm', '']) {
    await assert.rejects(env.publisher.publish({ id: 'dashboard', workdir: env.workdir, ref, config: CONFIG }), (e: PublishError) => e.code === 'invalid_ref', ref)
  }
  await assert.rejects(env.publisher.publish({ id: 'dashboard', workdir: env.workdir, ref: 'no-such-branch', config: CONFIG }), (e: PublishError) => e.code === 'invalid_ref')
  assert.deepEqual(env.steps, [])
  assert.equal(env.docker.calls.length, 0)
})

test('the live resolver finds the container of the current release and caches briefly', async () => {
  const env = await setup()
  const live = await publish(env)
  let clock = 1000
  const resolver = createLiveResolver({ cli: env.docker.cli, releasesDir: env.releasesDir, network: NETWORK, ttlMs: 2000, now: () => clock })

  assert.equal(resolver.exists('dashboard'), true)
  assert.equal(resolver.exists('other'), false)
  assert.equal(resolver.exists('../dashboard'), false)
  assert.deepEqual(await resolver.resolve('other'), { state: 'none' })
  assert.deepEqual(await resolver.resolve('../dashboard'), { state: 'none' })

  const ip = env.docker.containers.get(live.container)!.ip
  assert.deepEqual(await resolver.resolve('dashboard'), { state: 'ready', target: `http://${ip}:3000` })
  const inspects = () => env.docker.calls.filter((c) => c[0] === 'inspect').length
  const before = inspects()
  await resolver.resolve('dashboard')
  assert.equal(inspects(), before, 'cached')
  env.docker.containers.get(live.container)!.running = false
  clock += 1000
  assert.equal((await resolver.resolve('dashboard')).state, 'ready', 'still within the ttl')
  clock += 2000
  assert.deepEqual(await resolver.resolve('dashboard'), { state: 'down' })
})

test('the live resolver ignores a pointer file that is not what the publisher writes', async () => {
  const env = await setup()
  await publish(env)
  const resolver = createLiveResolver({ cli: env.docker.cli, releasesDir: env.releasesDir, network: NETWORK, ttlMs: 0 })
  const file = path.join(env.releasesDir, 'dashboard/current.json')
  const good = JSON.parse(readFileSync(file, 'utf8'))
  const cases = [
    { ...good, container: '--privileged' },
    { ...good, container: 'other-container' },
    { ...good, port: 0 },
    { ...good, port: '3000; id' },
    { ...good, releaseId: '../../x' },
    { ...good, commit: 'abc' },
  ]
  for (const bad of cases) {
    await writeFile(file, JSON.stringify(bad))
    assert.deepEqual(await resolver.resolve('dashboard'), { state: 'none' }, JSON.stringify(bad))
  }
  await writeFile(file, '{not json')
  assert.deepEqual(await resolver.resolve('dashboard'), { state: 'none' })
  assert.ok(!env.docker.calls.some((c) => c.includes('--privileged')))
})

test('the named branch is published, not whatever is checked out', async () => {
  const env = await setup()
  git(env.workdir, 'checkout', '-q', '-b', 'builder/run-1')
  env.src.commit('work in progress')
  const release = await publish(env)
  assert.equal(readFileSync(path.join(env.releasesDir, 'dashboard/releases', release.id, 'app/src/version.txt'), 'utf8'), 'one\n')
  assert.equal(current(env).commit, git(env.workdir, 'rev-parse', 'main'))
})

test('pruning keeps the live release even when the clock went backwards', async () => {
  const env = await setup({ keep: 2 })
  await publish(env)
  env.src.commit('two')
  await publish(env)
  env.clock.ms -= 24 * 3600_000
  env.src.commit('three')
  const three = await publish(env)
  assert.ok(releaseDirs(env).includes(three.id), 'the live release is the oldest by time and must stay')
  assert.equal(current(env).releaseId, three.id)
  assert.ok(existsSync(path.join(env.releasesDir, 'dashboard/releases', three.id, 'app/dist/built.txt')))
})

test('failure output is cleaned up: no colour codes or stack frames, and the error line is kept', async () => {
  const esc = String.fromCharCode(27)
  const noisy = [
    'vite v8 building for production...',
    'error during build:',
    `${esc}[31m[UNRESOLVED_IMPORT] ${esc}[0mCould not resolve './lib/broken' in src/routes/index.tsx`,
    `   ${esc}[38;5;246m╭─${esc}[0m[ src/routes/index.tsx:5:8 ]`,
    '   │',
    '    at aggregateBindingErrorsIntoJsError (file:///work/node_modules/x.mjs:48:18)',
    '    at async buildEnvironment (file:///work/node_modules/y.js:1:1)',
    'error: script "build" exited with code 1',
  ].join('\n')
  const text = excerpt(noisy)
  assert.ok(!text.includes(esc) && !/\n\s+at /.test(text) && !/^[\s│╭─]+$/m.test(text))
  assert.match(text, /Could not resolve '\.\/lib\/broken' in src\/routes\/index\.tsx/)
  assert.match(text, /script "build" exited with code 1/)

  const long = ['first useful line', ...Array.from({ length: 400 }, (_, i) => `noise ${i}`), 'last useful line'].join('\n')
  const short = excerpt(long, 500)
  assert.ok(short.length <= 520)
  assert.ok(short.startsWith('first useful line') && short.endsWith('last useful line') && short.includes('\n…\n'))

  const env = await setup()
  env.failBuild.value = true
  env.failBuild.output = noisy
  await assert.rejects(publish(env), (e: PublishError) => /Could not resolve/.test(e.message) && !e.message.includes(esc))
})
