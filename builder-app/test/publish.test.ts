import test from 'node:test'
import assert from 'node:assert/strict'
import { git } from '../../agent/src/git.ts'
import { PublishError, type Current, type PublishConfig, type ReleaseInfo } from '../../sandbox/src/release.ts'
import { createPublicationManager } from '../src/publish.ts'
import { RunError } from '../src/runs.ts'
import { commitOnBase, makeRepo, project, waitFor } from './helpers.ts'

const CONFIG: PublishConfig = { build: ['bun', 'run', 'build'], start: ['bun', 'run', 'start'], port: 3000, healthPath: '/', env: { DIG_GATEWAY_TOKEN: 'live-secret' } }

/** Keeps releases in memory; can be held open or made to fail. */
function fakePublisher() {
  type State = { current: Current | null; releases: ReleaseInfo[] }
  const states = new Map<string, State>()
  const stateOf = (id: string) => {
    if (!states.has(id)) states.set(id, { current: null, releases: [] })
    return states.get(id)!
  }
  const calls: string[] = []
  const control: { gate: Promise<void>; failure: Error | null } = { gate: Promise.resolve(), failure: null }
  let n = 0
  const makeRelease = (commit: string): ReleaseInfo => {
    n += 1
    return { id: `r${n}-${commit.slice(0, 7)}`, commit, createdAt: `2026-10-06T08:0${n}:00.000Z`, container: `dig-live-x-r${n}`, port: 3000 }
  }
  const goLive = (id: string, release: ReleaseInfo) => {
    stateOf(id).current = { releaseId: release.id, commit: release.commit, container: release.container, port: 3000, publishedAt: '2026-10-06T09:00:00.000Z' }
  }
  return {
    calls, control,
    async list(id: string) {
      const state = stateOf(id)
      return { current: state.current, releases: [...state.releases].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
    },
    async publish(input: { id: string; workdir: string; ref: string; config: PublishConfig; onPhase?: (p: 'build') => void }) {
      calls.push(`publish ${input.ref}`)
      assert.deepEqual(input.config.env, CONFIG.env)
      input.onPhase?.('build')
      await control.gate
      if (control.failure) throw control.failure
      const release = makeRelease((await git(input.workdir, ['rev-parse', input.ref])).trim())
      stateOf(input.id).releases.push(release)
      goLive(input.id, release)
      return release
    },
    async rollback(input: { id: string; releaseId?: string }) {
      calls.push(`rollback ${input.releaseId ?? ''}`)
      await control.gate
      if (control.failure) throw control.failure
      const state = stateOf(input.id)
      const target = state.releases.find((r) => r.id === input.releaseId) ?? state.releases.find((r) => r.id !== state.current?.releaseId)!
      goLive(input.id, target)
      return target
    },
    async restart(input: { id: string }) {
      calls.push('restart')
      await control.gate
      const state = stateOf(input.id)
      return state.releases.find((r) => r.id === state.current?.releaseId)!
    },
  }
}

async function setup(extra: { second?: boolean; maxConcurrent?: number } = {}) {
  const root = await makeRepo()
  const publisher = fakePublisher()
  const logs: Record<string, unknown>[] = []
  const plain = await makeRepo()
  const projects = [project(root, { publish: { config: CONFIG, url: 'https://dashboard-live.example.nl' } })]
  if (extra.second) projects.push(project(await makeRepo(), { id: 'other', publish: { config: CONFIG } }))
  const manager = createPublicationManager({ projects: [...projects, project(plain, { id: 'plain' })], publisher: publisher as never, maxConcurrent: extra.maxConcurrent, log: (e) => logs.push(e) })
  const hold = () => {
    let release!: () => void
    publisher.control.gate = new Promise<void>((resolve) => (release = resolve))
    return release
  }
  return { root, manager, publisher, logs, hold }
}

const idle = (manager: ReturnType<typeof createPublicationManager>, id = 'dashboard') => waitFor(async () => (await manager.status(id)).job?.state !== 'running', 'job to finish')

test('a project without publish settings reports it and refuses to publish', async () => {
  const t = await setup()
  assert.deepEqual(await t.manager.status('plain'), { enabled: false, url: null, current: null, releases: [], baseCommit: null, upToDate: null, job: null })
  await assert.rejects(t.manager.publish('plain'), (e: RunError) => e.status === 409 && e.code === 'publishing_disabled')
  await assert.rejects(t.manager.status('nope'), (e: RunError) => e.status === 404)
  assert.deepEqual(t.publisher.calls, [])
})

test('publish runs in the background and the status follows it: nothing live, running, up to date, outdated', async () => {
  const t = await setup()
  const before = await t.manager.status('dashboard')
  assert.equal(before.enabled, true)
  assert.equal(before.url, 'https://dashboard-live.example.nl')
  assert.equal(before.current, null)
  assert.equal(before.upToDate, null)
  assert.match(before.baseCommit ?? '', /^[0-9a-f]{40}$/)

  const release = t.hold()
  const started = await t.manager.publish('dashboard')
  assert.equal(started.job?.state, 'running')
  assert.equal(started.job?.kind, 'publish')
  await waitFor(async () => (await t.manager.status('dashboard')).job?.phase === 'build', 'phase')
  release()
  await idle(t.manager)

  const after = await t.manager.status('dashboard')
  assert.equal(after.job?.state, 'done')
  assert.equal(after.job?.phase, null)
  assert.equal(after.current?.commit, before.baseCommit)
  assert.equal(after.upToDate, true)
  assert.equal(after.releases.length, 1)
  assert.ok(after.releases[0].live)
  assert.deepEqual(t.publisher.calls, ['publish main'])

  await assert.rejects(t.manager.publish('dashboard'), (e: RunError) => e.status === 409 && e.code === 'already_current')
  await commitOnBase(t.root, 'src/app.ts', 'export const a = 3\n')
  assert.equal((await t.manager.status('dashboard')).upToDate, false)
  await t.manager.publish('dashboard')
  await idle(t.manager)
  assert.equal((await t.manager.status('dashboard')).upToDate, true)
  assert.deepEqual(t.logs.filter((l) => String(l.event).startsWith('publication_')).map((l) => l.event), ['publication_started', 'publication_done', 'publication_started', 'publication_done'])
})

test('a failed publication shows the reason; unexpected errors do not leak details', async () => {
  const t = await setup()
  t.publisher.control.failure = new PublishError('build_failed', 'De build mislukte.\nvite: x')
  await t.manager.publish('dashboard')
  await idle(t.manager)
  let status = await t.manager.status('dashboard')
  assert.equal(status.job?.state, 'failed')
  assert.equal(status.job?.error, 'De build mislukte.\nvite: x')
  assert.equal(status.current, null)

  t.publisher.control.failure = new Error('ENOENT: /srv/dig-builder/secret/path with token live-secret')
  await t.manager.publish('dashboard')
  await idle(t.manager)
  status = await t.manager.status('dashboard')
  assert.equal(status.job?.error, 'Er ging iets mis bij het publiceren.')
  assert.ok(!JSON.stringify(status).includes('live-secret') && !JSON.stringify(status).includes('/srv/'))
  const failed = t.logs.filter((l) => l.event === 'publication_failed')
  assert.equal(failed.length, 2)

  t.publisher.control.failure = null
  await t.manager.publish('dashboard')
  await idle(t.manager)
  assert.equal((await t.manager.status('dashboard')).job?.state, 'done', 'a new job replaces the failed one')
})

test('one publication per project, and a global limit', async () => {
  const t = await setup({ second: true })
  const release = t.hold()
  await t.manager.publish('dashboard')
  await assert.rejects(t.manager.publish('dashboard'), (e: RunError) => e.status === 409 && e.code === 'publish_busy')
  await assert.rejects(t.manager.publish('other'), (e: RunError) => e.status === 429 && e.code === 'too_many_publications')
  await assert.rejects(t.manager.restart('dashboard'), (e: RunError) => e.code === 'no_release', 'nothing is live yet, so there is nothing to restart')
  release()
  await idle(t.manager)
  await t.manager.publish('other')
  await idle(t.manager, 'other')
  assert.equal((await t.manager.status('other')).job?.state, 'done')
})

test('rollback and restart: checked up front, then done in the background', async () => {
  const t = await setup()
  await assert.rejects(t.manager.rollback('dashboard'), (e: RunError) => e.code === 'no_release')
  await assert.rejects(t.manager.restart('dashboard'), (e: RunError) => e.code === 'no_release')

  await t.manager.publish('dashboard')
  await idle(t.manager)
  const first = (await t.manager.status('dashboard')).current!.releaseId
  await commitOnBase(t.root, 'src/app.ts', 'export const a = 3\n')
  await t.manager.publish('dashboard')
  await idle(t.manager)
  const second = (await t.manager.status('dashboard')).current!.releaseId
  assert.notEqual(first, second)

  await assert.rejects(t.manager.rollback('dashboard', second), (e: RunError) => e.status === 409 && e.code === 'already_current')
  await assert.rejects(t.manager.rollback('dashboard', 'zzzz-0000000'), (e: RunError) => e.status === 404 && e.code === 'unknown_release')

  const started = await t.manager.rollback('dashboard', first)
  assert.equal(started.job?.kind, 'rollback')
  await idle(t.manager)
  const status = await t.manager.status('dashboard')
  assert.equal(status.current?.releaseId, first)
  assert.equal(status.upToDate, false, 'the base branch is ahead of what is live now')
  assert.deepEqual(status.releases.map((r) => [r.id, r.live]), [[second, false], [first, true]])

  await t.manager.restart('dashboard')
  await idle(t.manager)
  assert.equal((await t.manager.status('dashboard')).job?.kind, 'restart')
  assert.equal((await t.manager.status('dashboard')).job?.state, 'done')
})
