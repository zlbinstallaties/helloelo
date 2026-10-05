import { finishBranch, git } from '../../agent/src/git.ts'
import type { AgentEvent } from '../../agent/src/loop.ts'
import { EFFORTS, executeRun, newRunId, type Effort } from '../../agent/src/run.ts'
import type { Project } from './config.ts'
import type { RunMeta, Store } from './store.ts'

/*
 * Starts, follows, stops and decides agent runs.
 *
 * - One run at a time per project, and a global limit (each run costs money).
 * - A run works on branch builder/<id> of the project's checkout; afterwards the checkout is put back
 *   on the base branch. Nothing is pushed.
 * - A human decides: approve merges the branch into the base branch (no fast-forward, so the run stays
 *   visible in the history), reject deletes it.
 */

export class RunError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message = code) {
    super(message)
    this.name = 'RunError'
    this.status = status
    this.code = code
  }
}

export interface StartInput {
  task: unknown
  effort?: unknown
  maxCostUsd?: unknown
}

export interface RunManagerOptions {
  projects: readonly Project[]
  store: Store
  maxConcurrent?: number
  caBundle?: string
  /** Injection point for tests. */
  execute?: typeof executeRun
  now?: () => Date
}

const MAX_TASK_CHARS = 4000
const MIN_TASK_CHARS = 5
const MIN_COST = 0.1
const MAX_COST = 50
const DEFAULT_COST = 5

type Listener = (event: AgentEvent | { type: 'end'; turn: number; detail: Record<string, unknown> }) => void

interface Active {
  controller: AbortController
  events: AgentEvent[]
  listeners: Set<Listener>
  writes: Promise<void>
}

function cleanLine(text: string) {
  // Control characters (including newlines) must not end up in a commit message.
  return Array.from(text, (char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)).join('').trim().slice(0, 100)
}

export function createRunManager(options: RunManagerOptions) {
  const { store } = options
  const projects = new Map(options.projects.map((p) => [p.id, p]))
  const maxConcurrent = options.maxConcurrent ?? 2
  const execute = options.execute ?? executeRun
  const now = options.now ?? (() => new Date())
  const active = new Map<string, Active>()
  /** project id -> run id (a running run or a decision being applied) */
  const busy = new Map<string, string>()

  function project(id: string): Project {
    const found = projects.get(id)
    if (!found) throw new RunError(404, 'project_not_found')
    return found
  }

  async function currentBranch(p: Project) {
    return (await git(p.workdir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  }

  /** The checkout must be clean and on the base branch before a run starts or a decision is applied. */
  async function prepareRepo(p: Project) {
    const dirty = (await git(p.workdir, ['status', '--porcelain'])).trim()
    if (dirty) throw new RunError(409, 'workdir_dirty', 'De werkmap heeft niet-gecommitte wijzigingen; leg die eerst vast of verwijder ze.')
    if ((await currentBranch(p)) !== p.baseBranch) await git(p.workdir, ['switch', '-q', p.baseBranch])
  }

  /** A run that failed half-way leaves uncommitted work; keep it on the run's branch so the checkout is clean again. */
  async function salvage(p: Project, meta: RunMeta) {
    try {
      if (meta.branch && (await currentBranch(p)) === meta.branch) {
        await finishBranch(p.workdir, { branch: meta.branch, base: 'HEAD', previous: p.baseBranch }, `DIG Builder: onvolledig (run ${meta.id})`)
      }
    } catch {
      // restoreBase and the next start report what is wrong.
    }
  }

  async function restoreBase(p: Project) {
    try {
      if ((await currentBranch(p)) !== p.baseBranch) await git(p.workdir, ['switch', '-q', p.baseBranch])
    } catch {
      // The checkout stays where it is; the next start reports it.
    }
  }

  function validate(input: StartInput) {
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (task.length < MIN_TASK_CHARS) throw new RunError(400, 'invalid_task', 'Beschrijf de opdracht (minstens een paar woorden).')
    if (task.length > MAX_TASK_CHARS) throw new RunError(400, 'invalid_task', `De opdracht is te lang (maximaal ${MAX_TASK_CHARS} tekens).`)
    const effort = (input.effort ?? 'high') as Effort
    if (!EFFORTS.includes(effort)) throw new RunError(400, 'invalid_effort')
    const maxCostUsd = input.maxCostUsd === undefined ? DEFAULT_COST : Number(input.maxCostUsd)
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < MIN_COST || maxCostUsd > MAX_COST) {
      throw new RunError(400, 'invalid_cost', `De kostenlimiet moet tussen $${MIN_COST} en $${MAX_COST} liggen.`)
    }
    return { task, effort, maxCostUsd }
  }

  function emit(runId: string, event: AgentEvent) {
    const run = active.get(runId)
    if (!run) return
    run.events.push(event)
    run.writes = run.writes.then(() => store.appendEvent(runId, event)).catch(() => {})
    for (const listener of run.listeners) listener(event)
  }

  async function runInBackground(meta: RunMeta, p: Project, input: ReturnType<typeof validate>) {
    const run = active.get(meta.id)!
    try {
      const outcome = await execute({
        workdir: p.workdir,
        task: input.task,
        outDir: store.runsDir,
        runId: meta.id,
        effort: input.effort,
        maxCostUsd: input.maxCostUsd,
        sandbox: p.sandbox,
        gateway: p.gateway,
        caBundle: options.caBundle,
        signal: run.controller.signal,
        onEvent(event) {
          if (event.type === 'phase' && event.detail.phase === 'branch') {
            meta.branch = String(event.detail.branch)
            store.save(meta)
          }
          emit(meta.id, event)
        },
      })
      meta.state = outcome.status === 'error' ? 'failed' : 'finished'
      meta.status = outcome.status
      meta.branch = outcome.branch
      meta.commit = outcome.commit
      meta.turns = outcome.turns
      meta.estimatedCostUsd = outcome.estimatedCostUsd
      meta.changedFiles = outcome.changedFiles
      meta.stat = outcome.stat
      meta.summary = outcome.summary
      meta.error = outcome.error
    } catch (error) {
      meta.state = 'failed'
      meta.status = 'error'
      meta.error = error instanceof Error ? error.message : String(error)
    } finally {
      meta.finishedAt = now().toISOString()
      await run.writes
      if (meta.state === 'failed') await salvage(p, meta)
      await restoreBase(p)
      // Publish the final state and release the project in one synchronous step: whoever sees
      // "finished" can start the next run or decide right away.
      store.save(meta)
      active.delete(meta.id)
      busy.delete(p.id)
      for (const listener of run.listeners) listener({ type: 'end', turn: meta.turns, detail: { state: meta.state, status: meta.status } })
    }
  }

  return {
    maxConcurrent,

    /** Runs that were still marked running when the server stopped cannot continue. */
    async recover() {
      for (const meta of await store.list()) {
        if (meta.state !== 'running' || active.has(meta.id)) continue
        meta.state = 'failed'
        meta.status = 'error'
        meta.error = 'De server is herstart tijdens deze run; hij is afgebroken.'
        meta.finishedAt = now().toISOString()
        store.save(meta)
      }
    },

    async start(projectId: string, input: StartInput): Promise<RunMeta> {
      const p = project(projectId)
      const valid = validate(input)
      if (active.size >= maxConcurrent) throw new RunError(429, 'too_many_runs', 'Er lopen al te veel opdrachten tegelijk.')
      if (busy.has(p.id)) throw new RunError(409, 'project_busy', 'Er loopt al een opdracht voor dit project.')
      const id = newRunId()
      busy.set(p.id, id)
      try {
        await prepareRepo(p)
        const meta: RunMeta = {
          id, projectId: p.id, task: valid.task, effort: valid.effort, maxCostUsd: valid.maxCostUsd,
          state: 'running', status: null, createdAt: now().toISOString(), finishedAt: null,
          branch: null, commit: null, turns: 0, estimatedCostUsd: 0, changedFiles: [], stat: '', summary: '', error: null,
          decision: null, decidedAt: null, mergeCommit: null,
        }
        await store.create(meta)
        active.set(id, { controller: new AbortController(), events: [], listeners: new Set(), writes: Promise.resolve() })
        void runInBackground(meta, p, valid)
        return { ...meta }
      } catch (error) {
        busy.delete(p.id)
        throw error
      }
    },

    stop(id: string) {
      const run = active.get(id)
      if (!run) throw new RunError(409, 'not_running', 'Deze opdracht loopt niet (meer).')
      run.controller.abort()
    },

    /** Backlog plus a live subscription for a running run; the stored events for a finished one. */
    async follow(id: string, listener: Listener): Promise<{ backlog: AgentEvent[]; live: boolean; unsubscribe: () => void }> {
      const run = active.get(id)
      if (!run) return { backlog: await store.events(id), live: false, unsubscribe: () => {} }
      run.listeners.add(listener)
      return { backlog: [...run.events], live: true, unsubscribe: () => run.listeners.delete(listener) }
    },

    isRunning: (id: string) => active.has(id),

    async approve(id: string): Promise<RunMeta> {
      const meta = await store.get(id)
      if (!meta) throw new RunError(404, 'run_not_found')
      const p = project(meta.projectId)
      if (meta.state !== 'finished' || !meta.commit || !meta.branch) throw new RunError(409, 'nothing_to_approve', 'Er zijn geen wijzigingen om goed te keuren.')
      if (meta.decision) throw new RunError(409, 'already_decided', 'Hierover is al besloten.')
      if (busy.has(p.id)) throw new RunError(409, 'project_busy', 'Er loopt al een opdracht voor dit project.')
      busy.set(p.id, id)
      try {
        await prepareRepo(p)
        const message = `DIG Builder: ${cleanLine(meta.task.split('\n')[0])} (run ${meta.id})`
        try {
          await git(p.workdir, ['-c', 'user.name=DIG Builder', '-c', 'user.email=dig-builder@localhost', 'merge', '--no-ff', '--no-verify', '-m', message, meta.branch])
        } catch {
          await git(p.workdir, ['merge', '--abort']).catch(() => {})
          throw new RunError(409, 'merge_conflict', `De wijzigingen passen niet meer op ${p.baseBranch} (die is intussen veranderd). Start de opdracht opnieuw.`)
        }
        meta.mergeCommit = (await git(p.workdir, ['rev-parse', 'HEAD'])).trim()
        await git(p.workdir, ['branch', '-d', meta.branch]).catch(() => {})
        meta.decision = 'approved'
        meta.decidedAt = now().toISOString()
        store.save(meta)
        return meta
      } finally {
        busy.delete(p.id)
      }
    },

    async reject(id: string): Promise<RunMeta> {
      const meta = await store.get(id)
      if (!meta) throw new RunError(404, 'run_not_found')
      const p = project(meta.projectId)
      if (meta.state === 'running') throw new RunError(409, 'still_running', 'Stop de opdracht eerst.')
      if (meta.decision) throw new RunError(409, 'already_decided', 'Hierover is al besloten.')
      if (busy.has(p.id)) throw new RunError(409, 'project_busy', 'Er loopt al een opdracht voor dit project.')
      busy.set(p.id, id)
      try {
        await prepareRepo(p)
        if (meta.branch) await git(p.workdir, ['branch', '-D', meta.branch]).catch(() => {})
        meta.decision = 'rejected'
        meta.decidedAt = now().toISOString()
        store.save(meta)
        return meta
      } finally {
        busy.delete(p.id)
      }
    },
  }
}

export type RunManager = ReturnType<typeof createRunManager>
