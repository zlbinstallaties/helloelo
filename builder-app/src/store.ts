import { renameSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent } from '../../agent/src/loop.ts'

/*
 * Run records on disk: <dataDir>/runs/<run-id>/{meta.json, events.jsonl, changes.diff, run.json}.
 * meta.json is what the UI lists; the agent library writes run.json and changes.diff next to it.
 */

export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,40}$/

export type RunState = 'running' | 'finished' | 'failed'
export type Decision = 'approved' | 'rejected' | null

export interface RunMeta {
  id: string
  projectId: string
  task: string
  effort: string
  maxCostUsd: number
  state: RunState
  /** Agent status once finished: done, budget, max_turns, refusal, stopped, error, ... */
  status: string | null
  createdAt: string
  finishedAt: string | null
  branch: string | null
  commit: string | null
  turns: number
  estimatedCostUsd: number
  changedFiles: string[]
  stat: string
  summary: string
  error: string | null
  decision: Decision
  decidedAt: string | null
  mergeCommit: string | null
}

export function createStore(dataDir: string) {
  const runsDir = path.join(dataDir, 'runs')

  function dir(id: string) {
    if (!RUN_ID_PATTERN.test(id)) throw new Error(`invalid run id: ${id}`)
    return path.join(runsDir, id)
  }

  // meta.json is small; writing it synchronously keeps state changes and in-memory bookkeeping in step.
  function writeJson(file: string, value: unknown) {
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2))
    renameSync(temp, file)
  }

  return {
    runsDir,
    runDir: dir,

    async create(meta: RunMeta) {
      await mkdir(dir(meta.id), { recursive: true })
      writeJson(path.join(dir(meta.id), 'meta.json'), meta)
    },

    /** Synchronous so a state change becomes visible in the same tick as the bookkeeping that goes with it. */
    save(meta: RunMeta) {
      writeJson(path.join(dir(meta.id), 'meta.json'), meta)
    },

    async get(id: string): Promise<RunMeta | null> {
      try {
        return JSON.parse(await readFile(path.join(dir(id), 'meta.json'), 'utf8')) as RunMeta
      } catch {
        return null
      }
    },

    async list(): Promise<RunMeta[]> {
      let ids: string[]
      try {
        ids = await readdir(runsDir)
      } catch {
        return []
      }
      const metas = await Promise.all(ids.filter((id) => RUN_ID_PATTERN.test(id)).map((id) => this.get(id)))
      return metas.filter((m): m is RunMeta => m !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    async appendEvent(id: string, event: AgentEvent) {
      await appendFile(path.join(dir(id), 'events.jsonl'), `${JSON.stringify(event)}\n`)
    },

    async events(id: string): Promise<AgentEvent[]> {
      try {
        return (await readFile(path.join(dir(id), 'events.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AgentEvent)
      } catch {
        return []
      }
    },

    async diff(id: string): Promise<string> {
      try {
        return await readFile(path.join(dir(id), 'changes.diff'), 'utf8')
      } catch {
        return ''
      }
    },
  }
}

export type Store = ReturnType<typeof createStore>
