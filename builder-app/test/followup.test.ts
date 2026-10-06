import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { git } from '../../agent/src/git.ts'
import { followUpTask, RunError } from '../src/runs.ts'
import { commitOnBase, fakeExecute, fakeSequence, setup, waitFor } from './helpers.ts'

const FIRST = 'Zet a op 2 in het dashboard'
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    assert.ok(error instanceof RunError, String(error))
    return error.code
  }
  assert.fail('expected an error')
}

type Env = Awaited<ReturnType<typeof setup>>
const finished = (t: Env, id: string) => waitFor(async () => (await t.store.get(id))?.state !== 'running', `run ${id} to finish`)
const branches = async (t: Env) => (await git(t.root, ['branch', '--list', '--format=%(refname:short)'])).split('\n').filter(Boolean).sort()
const onMain = async (t: Env, file: string) => readFile(path.join(t.root, file), 'utf8').catch(() => null)

async function firstRun(t: Env, task = FIRST) {
  const run = await t.runs.start('dashboard', { task })
  await finished(t, run.id)
  return (await t.store.get(run.id))!
}

test('a follow-up builds on the parent branch: it sees the parent changes and its own diff is only the new step', async () => {
  const tasks: string[] = []
  const filesSeen: string[][] = []
  const t = await setup(fakeSequence([
    { files: { 'src/app.ts': 'export const a = 2\n' }, summary: 'Ik heb a op **2** gezet.' },
    { files: { 'src/extra.ts': 'export const b = 3\n' }, onTask: (task, files) => { tasks.push(task); void files().then((f) => filesSeen.push(f)) } },
  ]))
  const parent = await firstRun(t)
  const child = await t.runs.start('dashboard', { task: 'Zet ook b op 3 in een nieuw bestand', parentRunId: parent.id })
  assert.equal(child.parentRunId, parent.id)
  assert.equal(child.task, 'Zet ook b op 3 in een nieuw bestand', 'the screen shows what the person typed')
  await finished(t, child.id)

  const done = (await t.store.get(child.id))!
  assert.equal(done.state, 'finished')
  assert.deepEqual(done.changedFiles, ['src/extra.ts'], 'only the new step')
  const diff = await t.store.diff(child.id)
  assert.match(diff, /src\/extra\.ts/)
  assert.ok(!diff.includes('src/app.ts'), 'the parent change is not repeated in the incremental diff')

  // The agent was told what came before, including that the summary may be too positive.
  assert.equal(tasks.length, 1)
  assert.match(tasks[0], /vervolgopdracht/)
  assert.match(tasks[0], new RegExp(FIRST))
  assert.match(tasks[0], /Ik heb a op \*\*2\*\* gezet\./)
  assert.match(tasks[0], /te positief zijn: controleer/)
  assert.match(tasks[0], /Nieuwe opdracht:\nZet ook b op 3/)

  // The branch contains both steps, the base branch neither, and the checkout is back on it.
  assert.equal((await git(t.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
  assert.equal(await onMain(t, 'src/app.ts'), 'export const a = 1\n')
  assert.deepEqual((await git(t.root, ['diff', '--name-only', `main...${done.branch}`])).trim().split('\n').sort(), ['src/app.ts', 'src/extra.ts'])
  assert.equal(await t.runs.totalDiff(child.id).then((d) => /src\/app\.ts/.test(d) && /src\/extra\.ts/.test(d)), true, 'the total diff has both steps')
})

test('approving the follow-up merges both steps and marks the earlier ones as superseded', async () => {
  const t = await setup(fakeSequence([
    { files: { 'src/app.ts': 'export const a = 2\n' } },
    { files: { 'src/extra.ts': 'export const b = 3\n' } },
    { files: { 'src/third.ts': 'export const c = 4\n' } },
  ]))
  const first = await firstRun(t)
  const second = await t.runs.start('dashboard', { task: 'Tweede stap erbij', parentRunId: first.id })
  await finished(t, second.id)
  const third = await t.runs.start('dashboard', { task: 'Derde stap erbij', parentRunId: second.id })
  await finished(t, third.id)

  const described = await t.runs.describe(third.id)
  assert.deepEqual(described.ancestors.map((a) => a.id), [second.id, first.id], 'nearest first')

  const approved = await t.runs.approve(third.id)
  assert.equal(approved.decision, 'approved')
  assert.equal(await onMain(t, 'src/app.ts'), 'export const a = 2\n')
  assert.equal(await onMain(t, 'src/extra.ts'), 'export const b = 3\n')
  assert.equal(await onMain(t, 'src/third.ts'), 'export const c = 4\n')
  for (const id of [first.id, second.id]) {
    const earlier = (await t.store.get(id))!
    assert.equal(earlier.decision, 'superseded', id)
    assert.equal(earlier.supersededBy, third.id)
  }
  assert.deepEqual(await branches(t), ['main'], 'no leftover builder branches')
  assert.equal(await code(t.runs.approve(first.id)), 'already_decided')
})

test('while a follow-up waits for a decision, its parent cannot be decided; rejecting the follow-up frees the parent', async () => {
  const t = await setup(fakeSequence([{ files: { 'src/app.ts': 'export const a = 2\n' } }, { files: { 'src/extra.ts': 'export const b = 3\n' } }]))
  const parent = await firstRun(t)
  const child = await t.runs.start('dashboard', { task: 'Voeg nog iets toe', parentRunId: parent.id })
  await finished(t, child.id)

  assert.equal(await code(t.runs.approve(parent.id)), 'has_followup')
  assert.equal(await code(t.runs.reject(parent.id)), 'has_followup')
  assert.equal(await code(t.runs.start('dashboard', { task: 'Nog een vervolg', parentRunId: parent.id })), 'has_followup')
  assert.deepEqual((await t.runs.describe(parent.id)).followUp?.id, child.id)

  await t.runs.reject(child.id)
  assert.equal((await t.runs.describe(parent.id)).followUp, null)
  assert.equal((await t.store.get(parent.id))!.decision, null, 'rejecting the follow-up leaves the parent alone')
  assert.ok((await branches(t)).includes(parent.branch!))
  const approved = await t.runs.approve(parent.id)
  assert.equal(approved.decision, 'approved')
  assert.equal(await onMain(t, 'src/app.ts'), 'export const a = 2\n')
  assert.equal(await onMain(t, 'src/extra.ts'), null, 'the rejected step is not in there')
})

test('a follow-up that changed nothing or failed does not block its parent', async () => {
  const t = await setup(fakeSequence([{ files: { 'src/app.ts': 'export const a = 2\n' } }, { files: {} }, { crash: true }]))
  const parent = await firstRun(t)
  const empty = await t.runs.start('dashboard', { task: 'Doe niets bijzonders' , parentRunId: parent.id })
  await finished(t, empty.id)
  assert.equal((await t.store.get(empty.id))!.commit, null)
  const crashed = await t.runs.start('dashboard', { task: 'Dit gaat mis', parentRunId: parent.id })
  await finished(t, crashed.id)
  assert.equal((await t.store.get(crashed.id))!.state, 'failed')
  assert.equal((await t.runs.describe(parent.id)).followUp, null)
  assert.equal((await t.runs.approve(parent.id)).decision, 'approved')
})

test('a running follow-up also blocks the parent', async () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const t = await setup(fakeSequence([{ files: { 'src/app.ts': 'export const a = 2\n' } }, { files: { 'src/extra.ts': 'x\n' }, gate }]))
  const parent = await firstRun(t)
  const child = await t.runs.start('dashboard', { task: 'Dit duurt even', parentRunId: parent.id })
  assert.equal(await code(t.runs.approve(parent.id)), 'has_followup')
  assert.equal((await t.runs.describe(parent.id)).followUp?.state, 'running')
  open()
  await finished(t, child.id)
})

test('a follow-up is only possible on a finished run with changes that nobody has decided on', async () => {
  const t = await setup(fakeSequence([{ files: { 'src/app.ts': 'export const a = 2\n' } }, { files: {} }, { files: { 'src/x.ts': 'x\n' } }, { files: { 'src/app.ts': 'export const a = 3\n' } }]))
  const parent = await firstRun(t)
  assert.equal(await code(t.runs.start('dashboard', { task: 'Vervolg op iets onbekends', parentRunId: 'bestaat-niet-123' })), 'run_not_found')
  for (const parentRunId of ['../../x', 42, '']) {
    assert.equal(await code(t.runs.start('dashboard', { task: 'Vervolg met rare id', parentRunId })), 'invalid_parent', String(parentRunId))
  }
  const empty = await t.runs.start('dashboard', { task: 'Niets te doen hier' })
  await finished(t, empty.id)
  assert.equal((await t.store.get(empty.id))!.commit, null)
  assert.equal(await code(t.runs.start('dashboard', { task: 'Vervolg op niets', parentRunId: empty.id })), 'nothing_to_follow_up')

  await t.runs.approve(parent.id)
  assert.equal(await code(t.runs.start('dashboard', { task: 'Vervolg op goedgekeurd', parentRunId: parent.id })), 'already_decided')

  // A run that is still running cannot be followed up.
  const another = await firstRun(t, 'Weer een nieuwe opdracht')
  await t.runs.reject(another.id)
  assert.equal(await code(t.runs.start('dashboard', { task: 'Vervolg op afgewezen', parentRunId: another.id })), 'already_decided')
  assert.equal((await git(t.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main', 'a refused follow-up leaves the checkout alone')
  assert.equal((await git(t.root, ['status', '--porcelain'])).trim(), '')
})

test('the parent branch disappearing is reported, not guessed around; the project is not left busy', async () => {
  const t = await setup(fakeSequence([{ files: { 'src/app.ts': 'export const a = 2\n' } }, { files: { 'src/x.ts': 'x\n' } }]))
  const parent = await firstRun(t)
  await git(t.root, ['branch', '-D', parent.branch!])
  assert.equal(await code(t.runs.start('dashboard', { task: 'Vervolg zonder branch', parentRunId: parent.id })), 'parent_branch_missing')
  const plain = await t.runs.start('dashboard', { task: 'Gewone opdracht daarna' })
  await finished(t, plain.id)
  assert.equal((await t.store.get(plain.id))!.state, 'finished')
})

test('a parent from another project is refused', async () => {
  const t = await setup(fakeExecute())
  const parent = await firstRun(t)
  const stored = (await t.store.get(parent.id))!
  stored.projectId = 'other'
  t.store.save(stored)
  assert.equal(await code(t.runs.start('dashboard', { task: 'Vervolg over de grens', parentRunId: parent.id })), 'run_not_found')
})

test('the follow-up task text tells the agent when the previous run stopped early, and caps the summary', () => {
  const base = { task: 'Eerste', summary: 'Gedaan', status: 'done' } as never
  assert.ok(!followUpTask(base, 'Verder').includes('voortijdig'))
  for (const status of ['budget', 'max_turns', 'stopped']) {
    assert.match(followUpTask({ ...(base as object), status } as never, 'Maak af'), /stopte voortijdig/, status)
  }
  const long = followUpTask({ ...(base as object), summary: 'x'.repeat(10_000) } as never, 'Verder')
  assert.ok(long.length < 3800, `capped, got ${long.length}`)
  assert.ok(!followUpTask({ ...(base as object), summary: '' } as never, 'Verder').includes('meldde'))
})

test('records written before follow-ups existed still load', async () => {
  const t = await setup(fakeExecute())
  const run = await firstRun(t)
  const stored = (await t.store.get(run.id))! as unknown as Record<string, unknown>
  delete stored.parentRunId
  delete stored.supersededBy
  t.store.save(stored as never)
  const loaded = (await t.store.get(run.id))!
  assert.equal(loaded.parentRunId, null)
  assert.equal(loaded.supersededBy, null)
  assert.equal((await t.runs.describe(run.id)).followUp, null)
})

test('the total diff needs the branch; it is gone after a decision', async () => {
  const t = await setup(fakeExecute())
  const run = await firstRun(t)
  await commitOnBase(t.root, 'src/other.ts', 'export const o = 1\n')
  const total = await t.runs.totalDiff(run.id)
  assert.match(total, /src\/app\.ts/)
  assert.ok(!total.includes('src/other.ts'), 'changes on the base branch are not part of this run')
  await t.runs.reject(run.id)
  assert.equal(await code(t.runs.totalDiff(run.id)), 'branch_gone')
})
