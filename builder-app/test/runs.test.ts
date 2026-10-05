import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { git } from '../../agent/src/git.ts'
import { RunError } from '../src/runs.ts'
import { commitOnBase, fakeExecute, makeRepo, setup, waitFor } from './helpers.ts'

const TASK = 'Zet a op 2 in het dashboard'
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    assert.ok(error instanceof RunError, String(error))
    return error.code
  }
  assert.fail('expected an error')
}

test('a run goes from running to finished, keeps its events, and the checkout returns to the base branch', async () => {
  const { root, store, runs } = await setup(fakeExecute())
  const meta = await runs.start('dashboard', { task: TASK })
  assert.equal(meta.state, 'running')
  await waitFor(async () => (await store.get(meta.id))?.state === 'finished', 'finished')
  const done = (await store.get(meta.id))!
  assert.deepEqual([done.status, done.branch, done.decision, done.error], ['done', `builder/${meta.id}`, null, null])
  assert.ok(done.commit)
  assert.deepEqual(done.changedFiles, ['src/app.ts'])
  assert.ok(done.finishedAt)
  assert.equal((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
  assert.equal(await readFile(path.join(root, 'src/app.ts'), 'utf8'), 'export const a = 1\n')
  assert.match(await store.diff(meta.id), /\+export const a = 2/)
  const events = await store.events(meta.id)
  assert.deepEqual(events.map((e) => e.type), ['phase', 'phase', 'tool'])
  assert.equal(runs.isRunning(meta.id), false)
})

test('input is validated', async () => {
  const { runs } = await setup(fakeExecute())
  assert.equal(await code(runs.start('nope', { task: TASK })), 'project_not_found')
  for (const task of [undefined, '', '  hoi ', 'x'.repeat(4001), 42]) {
    assert.equal(await code(runs.start('dashboard', { task })), 'invalid_task', String(task))
  }
  assert.equal(await code(runs.start('dashboard', { task: TASK, effort: 'extreme' })), 'invalid_effort')
  for (const maxCostUsd of [0, -1, 51, 'veel', NaN]) {
    assert.equal(await code(runs.start('dashboard', { task: TASK, maxCostUsd })), 'invalid_cost', String(maxCostUsd))
  }
})

test('one run at a time per project, and a global limit', async () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const { runs, store } = await setup(fakeExecute({ gate }), { maxConcurrent: 1 })
  const first = await runs.start('dashboard', { task: TASK })
  assert.equal(await code(runs.start('dashboard', { task: TASK })), 'too_many_runs')
  open()
  await waitFor(async () => (await store.get(first.id))?.state === 'finished', 'first finished')
  const second = await runs.start('dashboard', { task: TASK })
  assert.ok(second.id !== first.id)
})

test('a second project can run next to the first, the same project cannot', async () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const { project } = await import('./helpers.ts')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { createStore } = await import('../src/store.ts')
  const { createRunManager } = await import('../src/runs.ts')
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'dig-ba-data-')))
  const runs = createRunManager({ projects: [project(await makeRepo()), project(await makeRepo(), { id: 'tweede' })], store, execute: fakeExecute({ gate }), maxConcurrent: 3 })
  const a = await runs.start('dashboard', { task: TASK })
  const b = await runs.start('tweede', { task: TASK })
  assert.equal(await code(runs.start('dashboard', { task: TASK })), 'project_busy')
  open()
  await waitFor(async () => (await store.get(a.id))?.state === 'finished' && (await store.get(b.id))?.state === 'finished', 'both finished')
})

test('a dirty checkout is refused; a clean checkout on another branch is put back on the base branch', async () => {
  const { root, runs, store } = await setup(fakeExecute())
  await git(root, ['checkout', '-q', '-b', 'elders'])
  const ok = await runs.start('dashboard', { task: TASK })
  await waitFor(async () => (await store.get(ok.id))?.state === 'finished', 'finished')
  assert.equal((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path.join(root, 'src/app.ts'), 'handmatig gewijzigd')
  assert.equal(await code(runs.start('dashboard', { task: TASK })), 'workdir_dirty')
})

test('stop aborts a running run; its work so far is kept for a decision', async () => {
  const { runs, store } = await setup(fakeExecute({ untilAborted: true }))
  const meta = await runs.start('dashboard', { task: TASK })
  await waitFor(() => runs.isRunning(meta.id) && true, 'running')
  await new Promise((resolve) => setTimeout(resolve, 50))
  runs.stop(meta.id)
  await waitFor(async () => (await store.get(meta.id))?.state === 'finished', 'stopped')
  assert.equal((await store.get(meta.id))!.status, 'stopped')
  assert.equal(await code(Promise.resolve().then(() => runs.stop(meta.id))), 'not_running')
})

test('approve merges the branch with a merge commit, deletes it, and can happen only once', async () => {
  const { root, runs, store } = await setup(fakeExecute())
  const meta = await runs.start('dashboard', { task: TASK })
  await waitFor(async () => (await store.get(meta.id))?.state === 'finished', 'finished')
  const approved = await runs.approve(meta.id)
  assert.equal(approved.decision, 'approved')
  assert.ok(approved.mergeCommit && approved.decidedAt)
  assert.equal(await readFile(path.join(root, 'src/app.ts'), 'utf8'), 'export const a = 2\n')
  const parents = (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ')
  assert.equal(parents.length, 3, 'a merge commit has two parents')
  assert.match(await git(root, ['log', '-1', '--format=%s']), new RegExp(`DIG Builder: ${TASK.slice(0, 20)}.*\\(run ${meta.id}\\)`))
  assert.equal((await git(root, ['branch', '--list', `builder/${meta.id}`])).trim(), '')
  assert.equal(await code(runs.approve(meta.id)), 'already_decided')
  assert.equal(await code(runs.reject(meta.id)), 'already_decided')
})

test('approve reports a conflict, aborts the merge and leaves everything as it was', async () => {
  const { root, runs, store } = await setup(fakeExecute())
  const meta = await runs.start('dashboard', { task: TASK })
  await waitFor(async () => (await store.get(meta.id))?.state === 'finished', 'finished')
  await commitOnBase(root, 'src/app.ts', 'export const a = 99\n')
  assert.equal(await code(runs.approve(meta.id)), 'merge_conflict')
  assert.equal((await git(root, ['status', '--porcelain'])).trim(), '')
  assert.equal(await readFile(path.join(root, 'src/app.ts'), 'utf8'), 'export const a = 99\n')
  assert.equal((await store.get(meta.id))!.decision, null)
  assert.match(await git(root, ['branch', '--list', `builder/${meta.id}`]), /builder\//)
})

test('reject deletes the branch and leaves the base branch untouched', async () => {
  const { root, runs, store } = await setup(fakeExecute())
  const meta = await runs.start('dashboard', { task: TASK })
  await waitFor(async () => (await store.get(meta.id))?.state === 'finished', 'finished')
  const rejected = await runs.reject(meta.id)
  assert.equal(rejected.decision, 'rejected')
  assert.equal((await git(root, ['branch', '--list', `builder/${meta.id}`])).trim(), '')
  assert.equal(await readFile(path.join(root, 'src/app.ts'), 'utf8'), 'export const a = 1\n')
  assert.equal(await code(runs.approve(meta.id)), 'already_decided')
})

test('a run that crashes half-way keeps its work on its branch and leaves a clean checkout', async () => {
  const { root, runs, store } = await setup(fakeExecute({ crash: true }))
  const meta = await runs.start('dashboard', { task: TASK })
  await waitFor(async () => (await store.get(meta.id))?.state === 'failed', 'failed')
  const failed = (await store.get(meta.id))!
  assert.deepEqual([failed.status, failed.error], ['error', 'Claude API 500: boem'])
  assert.equal((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
  assert.equal((await git(root, ['status', '--porcelain'])).trim(), '')
  assert.match(await git(root, ['log', `builder/${meta.id}`, '-1', '--format=%s']), /onvolledig/)
  assert.equal(await code(runs.approve(meta.id)), 'nothing_to_approve')
  await runs.reject(meta.id)
  assert.equal((await git(root, ['branch', '--list', `builder/${meta.id}`])).trim(), '')
  const next = await runs.start('dashboard', { task: TASK })
  assert.ok(next.id)
})

test('runs that were still running when the server stopped are marked failed on recovery', async () => {
  const { runs, store } = await setup(fakeExecute())
  const meta = await runs.start('dashboard', { task: TASK })
  await waitFor(async () => (await store.get(meta.id))?.state === 'finished', 'finished')
  await store.create({ ...(await store.get(meta.id))!, id: '2026-10-05-aaaaaa', state: 'running', status: null, decision: null })
  await runs.recover()
  const recovered = (await store.get('2026-10-05-aaaaaa'))!
  assert.deepEqual([recovered.state, recovered.status], ['failed', 'error'])
  assert.match(recovered.error ?? '', /herstart/)
  assert.equal((await store.get(meta.id))!.state, 'finished')
})

test('following a run gives the backlog, live events and an end; a finished run replays from disk', async () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const { runs, store } = await setup(fakeExecute({ gate }))
  const meta = await runs.start('dashboard', { task: TASK })
  await waitFor(() => runs.isRunning(meta.id), 'running')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const seen: string[] = []
  const followed = await runs.follow(meta.id, (event) => seen.push(event.type))
  assert.equal(followed.live, true)
  assert.ok(followed.backlog.length >= 2)
  open()
  await waitFor(() => seen.includes('end'), 'end')
  const replay = await runs.follow(meta.id, () => {})
  assert.deepEqual([replay.live, replay.backlog.length > 0], [false, true])
  void store
})
