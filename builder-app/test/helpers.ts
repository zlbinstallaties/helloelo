import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { branchName, finishBranch, git, startBranch } from '../../agent/src/git.ts'
import type { AgentEvent } from '../../agent/src/loop.ts'
import type { executeRun, RunOutcome } from '../../agent/src/run.ts'
import type { Project } from '../src/config.ts'
import { createRunManager, type RunManager } from '../src/runs.ts'
import { createStore, type Store } from '../src/store.ts'

export async function makeRepo(files: Record<string, string> = { 'src/app.ts': 'export const a = 1\n' }, base = 'main') {
  const root = await mkdtemp(path.join(tmpdir(), 'dig-ba-repo-'))
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), contents)
  }
  await git(root, ['init', '-q', '-b', base])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  return root
}

export function project(workdir: string, overrides: Partial<Project> = {}): Project {
  return { id: 'dashboard', name: 'Dashboard', workdir, baseBranch: 'main', sandbox: false, ...overrides }
}

export async function commitOnBase(root: string, file: string, contents: string) {
  await writeFile(path.join(root, file), contents)
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `change ${file}`])
}

export interface FakeOptions {
  files?: Record<string, string>
  /** Resolve only once the run is aborted. */
  untilAborted?: boolean
  /** Return status "error" and leave the work uncommitted, like a crash half-way. */
  crash?: boolean
  /** Wait for this promise before finishing. */
  gate?: Promise<void>
  status?: RunOutcome['status']
  /** Called with the task text the agent would receive. */
  onTask?: (task: string, workdirFiles: () => Promise<string[]>) => void
  summary?: string
}

/** One FakeOptions per call, in order: the first run does one thing, its follow-up another. */
export function fakeSequence(steps: FakeOptions[]): typeof executeRun {
  const executes = steps.map((step) => fakeExecute(step))
  let next = 0
  return ((config) => executes[Math.min(next++, executes.length - 1)](config)) as typeof executeRun
}

/** A stand-in for executeRun that uses the real git helpers but no model. */
export function fakeExecute(options: FakeOptions = {}): typeof executeRun {
  const files = options.files ?? { 'src/app.ts': 'export const a = 2\n' }
  return (async (config) => {
    const onEvent = config.onEvent ?? (() => {})
    const runId = config.runId!
    options.onTask?.(config.task, async () => (await git(config.workdir, ['ls-files'])).split('\n').filter(Boolean))
    const started = await startBranch(config.workdir, branchName(runId))
    onEvent({ type: 'phase', turn: 0, detail: { phase: 'branch', branch: started.branch, base: started.base } })
    onEvent({ type: 'phase', turn: 0, detail: { phase: 'agent' } })
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(config.workdir, name)), { recursive: true })
      await writeFile(path.join(config.workdir, name), contents)
      onEvent({ type: 'tool', turn: 1, detail: { name: 'write_file', path: name, ok: true } } as AgentEvent)
    }
    if (options.untilAborted) {
      await new Promise<void>((resolve) => {
        if (config.signal?.aborted) resolve()
        config.signal?.addEventListener('abort', () => resolve())
      })
    }
    await options.gate
    const runDir = path.join(config.outDir, runId)
    const base = { runId, branch: started.branch, base: started.base, previous: started.previous, runDir, changedFiles: Object.keys(files), excluded: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }
    if (options.crash) {
      return { ...base, status: 'error', error: 'Claude API 500: boem', summary: '', turns: 1, estimatedCostUsd: 0.01, commit: null, stat: '' } as RunOutcome
    }
    const finished = await finishBranch(config.workdir, started, `DIG Builder: ${config.task.slice(0, 40)}`)
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'changes.diff'), finished.diff)
    const status = options.untilAborted ? 'stopped' : (options.status ?? 'done')
    return { ...base, status, error: null, summary: options.summary ?? 'Klaar: **a** is nu 2.', turns: 2, estimatedCostUsd: 0.1234, commit: finished.commit, stat: finished.stat } as RunOutcome
  }) as typeof executeRun
}

export async function setup(execute: typeof executeRun, extra: { maxConcurrent?: number; projects?: Project[] } = {}) {
  const root = await makeRepo()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dig-ba-data-'))
  const store: Store = createStore(dataDir)
  const projects = extra.projects ?? [project(root)]
  const runs: RunManager = createRunManager({ projects, store, execute, maxConcurrent: extra.maxConcurrent })
  return { root, dataDir, store, runs, projects }
}

export async function waitFor(check: () => Promise<boolean> | boolean, what = 'condition', timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}
