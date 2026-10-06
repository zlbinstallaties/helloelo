import { git } from '../../agent/src/git.ts'
import type { Publisher, PublishPhase } from '../../sandbox/src/release.ts'
import { PublishError } from '../../sandbox/src/release.ts'
import type { Project } from './config.ts'
import { RunError } from './runs.ts'

/*
 * Publishing from the builder app: put the current state of a project's base branch live, or go back
 * to an older version. The work (export, install, build, start, health check) takes minutes, so it
 * runs in the background; the screen polls status().
 *
 * Only one job per project, and a global limit (a build uses up to 2 GB of memory).
 */

export type PublicationKind = 'publish' | 'rollback' | 'restart'

export interface PublicationJob {
  kind: PublicationKind
  state: 'running' | 'done' | 'failed'
  phase: PublishPhase | null
  startedAt: string
  finishedAt: string | null
  error: string | null
  releaseId: string | null
}

export interface PublicationStatus {
  enabled: boolean
  url: string | null
  current: { releaseId: string; commit: string; publishedAt: string } | null
  releases: { id: string; commit: string; createdAt: string; live: boolean }[]
  baseCommit: string | null
  /** True when the live version is the tip of the base branch; null when nothing is live yet. */
  upToDate: boolean | null
  job: PublicationJob | null
}

export interface PublicationManagerOptions {
  projects: readonly Project[]
  publisher: Pick<Publisher, 'publish' | 'rollback' | 'restart' | 'list'>
  maxConcurrent?: number
  now?: () => Date
  log?: (entry: Record<string, unknown>) => void
}

export function createPublicationManager(options: PublicationManagerOptions) {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)))
  const maxConcurrent = options.maxConcurrent ?? 1
  const projects = new Map(options.projects.map((p) => [p.id, p]))
  const jobs = new Map<string, PublicationJob>()
  const running = new Set<string>()

  function project(id: string): Project {
    const found = projects.get(id)
    if (!found) throw new RunError(404, 'project_not_found')
    return found
  }

  function publishable(id: string) {
    const found = project(id)
    if (!found.publish) throw new RunError(409, 'publishing_disabled', 'Dit project kan niet worden gepubliceerd.')
    return { project: found, settings: found.publish }
  }

  async function baseCommit(p: Project) {
    try {
      const commit = (await git(p.workdir, ['rev-parse', '--verify', '--quiet', `${p.baseBranch}^{commit}`])).trim()
      return commit || null
    } catch {
      return null
    }
  }

  async function status(id: string): Promise<PublicationStatus> {
    const p = project(id)
    if (!p.publish) return { enabled: false, url: null, current: null, releases: [], baseCommit: null, upToDate: null, job: null }
    const { current, releases } = await options.publisher.list(id)
    const base = await baseCommit(p)
    return {
      enabled: true,
      url: p.publish.url ?? null,
      current: current ? { releaseId: current.releaseId, commit: current.commit, publishedAt: current.publishedAt } : null,
      releases: releases.map((r) => ({ id: r.id, commit: r.commit, createdAt: r.createdAt, live: r.id === current?.releaseId })),
      baseCommit: base,
      upToDate: current ? current.commit === base : null,
      job: jobs.get(id) ?? null,
    }
  }

  function begin(id: string, kind: PublicationKind, work: (onPhase: (phase: PublishPhase) => void) => Promise<{ id: string }>) {
    if (running.has(id)) throw new RunError(409, 'publish_busy', 'Er loopt al een publicatie voor dit project.')
    if (running.size >= maxConcurrent) throw new RunError(429, 'too_many_publications', 'Er wordt al een ander project gepubliceerd. Probeer het zo opnieuw.')
    const job: PublicationJob = { kind, state: 'running', phase: null, startedAt: now().toISOString(), finishedAt: null, error: null, releaseId: null }
    jobs.set(id, job)
    running.add(id)
    log({ event: 'publication_started', project: id, kind })
    work((phase) => {
      job.phase = phase
    }).then(
      (release) => {
        job.state = 'done'
        job.releaseId = release.id
        job.phase = null
        job.finishedAt = now().toISOString()
        running.delete(id)
        log({ event: 'publication_done', project: id, kind, release: release.id })
      },
      (error) => {
        job.state = 'failed'
        job.phase = null
        job.finishedAt = now().toISOString()
        job.error = error instanceof PublishError ? error.message : 'Er ging iets mis bij het publiceren.'
        running.delete(id)
        log({ event: 'publication_failed', project: id, kind, code: error instanceof PublishError ? error.code : 'unexpected', message: error instanceof Error ? error.message.slice(0, 500) : String(error) })
      },
    )
  }

  return {
    isEnabled: (id: string) => Boolean(projects.get(id)?.publish),
    status,

    /** Puts the tip of the base branch live. */
    async publish(id: string) {
      const { project: p, settings } = publishable(id)
      const { current } = await options.publisher.list(id)
      const base = await baseCommit(p)
      if (!base) throw new RunError(409, 'no_base', `De branch ${p.baseBranch} bestaat niet in dit project.`)
      if (current?.commit === base) throw new RunError(409, 'already_current', 'De nieuwste versie is al gepubliceerd.')
      begin(id, 'publish', (onPhase) => options.publisher.publish({ id, workdir: p.workdir, ref: p.baseBranch, config: settings.config, onPhase }))
      return status(id)
    },

    /** Goes back to an older version (default: the one before the live one). */
    async rollback(id: string, releaseId?: string) {
      const { settings } = publishable(id)
      const { current, releases } = await options.publisher.list(id)
      if (!current) throw new RunError(409, 'no_release', 'Er is nog niets gepubliceerd.')
      if (releaseId !== undefined) {
        if (releaseId === current.releaseId) throw new RunError(409, 'already_current', 'Deze versie is al gepubliceerd.')
        if (!releases.some((r) => r.id === releaseId)) throw new RunError(404, 'unknown_release', 'Die versie is niet meer beschikbaar.')
      }
      begin(id, 'rollback', (onPhase) => options.publisher.rollback({ id, config: settings.config, releaseId, onPhase }))
      return status(id)
    },

    /** Starts the live version again after it stopped. */
    async restart(id: string) {
      const { settings } = publishable(id)
      const { current } = await options.publisher.list(id)
      if (!current) throw new RunError(409, 'no_release', 'Er is nog niets gepubliceerd.')
      begin(id, 'restart', (onPhase) => options.publisher.restart({ id, config: settings.config, onPhase }))
      return status(id)
    },
  }
}

export type PublicationManager = ReturnType<typeof createPublicationManager>
