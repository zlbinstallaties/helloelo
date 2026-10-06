import Anthropic from '@anthropic-ai/sdk'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createDockerCli, type DockerCli } from '../../sandbox/src/docker.ts'
import { createSandbox } from '../../sandbox/src/sandbox.ts'
import { createCheckRunner, createSandboxCheckRunner, DEFAULT_CHECKS, parseChecks, SANDBOX_CHECKS } from './checks.ts'
import { createSchemaReader } from './gateway.ts'
import { branchName, finishBranch, git, startBranch } from './git.ts'
import { DEFAULT_MODEL, runAgent, type AgentEvent, type MessagesClient, type RunStatus } from './loop.ts'
import { createHostProbe, createSandboxProbe } from './probe.ts'
import { buildSystemPrompt } from './prompt.ts'
import { Workspace } from './workspace.ts'

/*
 * One builder run on a local app checkout, as a library: used by the CLI and by the builder app.
 *
 * Creates branch builder/<run-id> from the current HEAD, lets the agent work, commits the result on
 * that branch and writes changes.diff and run.json to <outDir>/<run-id>. Never pushes.
 *
 * Errors before the branch exists (bad config, dirty working tree) are thrown. Once the branch exists,
 * a failure ends the run with status "error" and the branch stays for inspection.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface RunConfig {
  workdir: string
  task: string
  /** Directory that receives <run-id>/run.json and changes.diff; must lie outside the workdir. */
  outDir: string
  runId?: string
  model?: string
  effort?: Effort
  maxTurns?: number
  maxCostUsd?: number
  /** Install and run all checks in throwaway containers (needs Docker and the dig-sandbox image). */
  sandbox?: boolean
  /** Explicit checks file. Without it, a dig-checks.json in the project is used in sandbox mode only. */
  checksFile?: string
  gateway?: { url: string; token: string }
  caBundle?: string
  /** Keep the (empty) branch when the agent changed nothing. */
  keepBranch?: boolean
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
  /** Injection points for tests. */
  client?: MessagesClient
  dockerCli?: DockerCli
}

export interface RunOutcome {
  runId: string
  status: RunStatus | 'error'
  summary: string
  error: string | null
  turns: number
  estimatedCostUsd: number
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  branch: string
  base: string
  /** Branch that was checked out when the run started. */
  previous: string
  commit: string | null
  changedFiles: string[]
  excluded: string[]
  stat: string
  runDir: string
}

export function newRunId() {
  return `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`
}

export async function executeRun(config: RunConfig): Promise<RunOutcome> {
  const task = config.task
  if (!task.trim()) throw new Error('task is empty')
  const effort = config.effort ?? 'high'
  if (!EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`)
  const maxTurns = config.maxTurns ?? 40
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) throw new Error('maxTurns must be 1..200')
  const maxCostUsd = config.maxCostUsd ?? 5
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error('maxCostUsd must be a positive number')
  const model = config.model ?? DEFAULT_MODEL
  const onEvent = config.onEvent ?? (() => {})

  const runId = config.runId ?? newRunId()
  const runDir = path.resolve(config.outDir, runId)
  const workspace = await Workspace.open(config.workdir)
  if (runDir === workspace.root || runDir.startsWith(workspace.root + path.sep)) {
    throw new Error('outDir must be outside the working directory')
  }

  // The project's own dig-checks.json (tests, build, probe) runs only in the sandbox: it can execute
  // project code. On the host it needs an explicit checks file.
  const projectChecksFile = path.join(workspace.root, 'dig-checks.json')
  const checksFile = config.checksFile ?? (config.sandbox && existsSync(projectChecksFile) ? projectChecksFile : undefined)
  const configured = checksFile ? parseChecks(JSON.parse(await readFile(checksFile, 'utf8'))) : undefined
  // `probe` in the checks file is the command behind the probe_app tool, not a check the model can name.
  const { probe: probeCommand, ...customChecks } = configured ?? {}
  const hasCustomChecks = Object.keys(customChecks).length > 0
  const sandbox = config.sandbox
    ? createSandbox({ cli: config.dockerCli ?? createDockerCli(), caBundle: config.caBundle })
    : null
  const tools = {
    workspace,
    checks: sandbox
      ? createSandboxCheckRunner(workspace.root, sandbox, hasCustomChecks ? customChecks : SANDBOX_CHECKS)
      : createCheckRunner(workspace.root, hasCustomChecks ? customChecks : DEFAULT_CHECKS),
    probe: probeCommand
      ? sandbox
        ? createSandboxProbe(workspace.root, sandbox, probeCommand)
        : createHostProbe(workspace.root, probeCommand)
      : undefined,
    odooSchema: config.gateway ? createSchemaReader(config.gateway.url, config.gateway.token) : undefined,
  }

  const started = await startBranch(workspace.root, branchName(runId))
  onEvent({ type: 'phase', turn: 0, detail: { phase: 'branch', branch: started.branch, base: started.base } })

  const log: AgentEvent[] = []
  const record = (event: AgentEvent) => {
    log.push(event)
    onEvent(event)
  }
  const outcome = (partial: Partial<RunOutcome> & Pick<RunOutcome, 'status'>): RunOutcome => ({
    runId,
    summary: '',
    error: null,
    turns: 0,
    estimatedCostUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    branch: started.branch,
    base: started.base,
    previous: started.previous,
    commit: null,
    changedFiles: [...workspace.changed].sort(),
    excluded: [],
    stat: '',
    runDir,
    ...partial,
  })

  let result: Awaited<ReturnType<typeof runAgent>> | null = null
  try {
    if (sandbox) {
      record({ type: 'phase', turn: 0, detail: { phase: 'install' } })
      const installed = await sandbox.install(workspace.root)
      if (!installed.ok) throw new Error(`installatie in de sandbox mislukt:\n${installed.output}`)
    }
    record({ type: 'phase', turn: 0, detail: { phase: 'agent' } })
    result = await runAgent({
      client: config.client ?? (new Anthropic() as unknown as MessagesClient),
      tools,
      system: await buildSystemPrompt(workspace),
      task,
      model,
      effort,
      maxTurns,
      maxCostUsd,
      signal: config.signal,
      onEvent: record,
    })
    record({ type: 'phase', turn: result.turns, detail: { phase: 'finish' } })
    const firstLine = task.trim().split('\n')[0].slice(0, 60)
    const finished = await finishBranch(
      workspace.root,
      started,
      `DIG Builder: ${firstLine}\n\nRun ${runId}, status ${result.status}, ${result.turns} turns.`,
    )
    const done = outcome({
      status: result.status,
      summary: result.summary,
      turns: result.turns,
      estimatedCostUsd: Number(result.estimatedCostUsd.toFixed(4)),
      usage: result.usage,
      commit: finished.commit,
      excluded: finished.excluded,
      stat: finished.stat,
    })
    await writeRunFiles(runDir, done, finished.diff, { task, model, effort, maxCostUsd, sandbox: Boolean(sandbox), events: log })
    if (!finished.commit && !config.keepBranch) {
      await git(workspace.root, ['switch', '-q', started.previous])
      await git(workspace.root, ['branch', '-q', '-D', started.branch])
    }
    return done
  } catch (error) {
    const reason = error instanceof Anthropic.APIError ? `Claude API ${error.status}: ${error.message}` : error instanceof Error ? error.message : String(error)
    const failed = outcome({
      status: 'error',
      error: reason,
      summary: result?.summary ?? '',
      turns: result?.turns ?? 0,
      estimatedCostUsd: Number((result?.estimatedCostUsd ?? 0).toFixed(4)),
      usage: result?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    await writeRunFiles(runDir, failed, '', { task, model, effort, maxCostUsd, sandbox: Boolean(sandbox), events: log }).catch(() => {})
    return failed
  }
}

async function writeRunFiles(
  runDir: string,
  outcome: RunOutcome,
  diff: string,
  extra: { task: string; model: string; effort: Effort; maxCostUsd: number; sandbox: boolean; events: AgentEvent[] },
) {
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'changes.diff'), diff)
  await writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId: outcome.runId,
        task: extra.task.slice(0, 2000),
        model: extra.model,
        effort: extra.effort,
        status: outcome.status,
        error: outcome.error,
        turns: outcome.turns,
        usage: outcome.usage,
        estimatedCostUsd: outcome.estimatedCostUsd,
        maxCostUsd: extra.maxCostUsd,
        sandbox: extra.sandbox,
        branch: outcome.branch,
        base: outcome.base,
        previous: outcome.previous,
        commit: outcome.commit,
        excluded: outcome.excluded,
        changedFiles: outcome.changedFiles,
        summary: outcome.summary,
        events: extra.events,
      },
      null,
      2,
    ),
  )
}
