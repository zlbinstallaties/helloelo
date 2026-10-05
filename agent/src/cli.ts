import Anthropic from '@anthropic-ai/sdk'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createDockerCli } from '../../sandbox/src/docker.ts'
import { createSandbox } from '../../sandbox/src/sandbox.ts'
import { createCheckRunner, createSandboxCheckRunner, DEFAULT_CHECKS, parseChecks, SANDBOX_CHECKS } from './checks.ts'
import { createSchemaReader } from './gateway.ts'
import { branchName, finishBranch, git, startBranch } from './git.ts'
import { DEFAULT_MODEL, runAgent } from './loop.ts'
import { buildSystemPrompt } from './prompt.ts'
import { Workspace } from './workspace.ts'

/*
 * One builder run on a local app checkout:
 *
 *   node --experimental-strip-types agent/src/cli.ts --workdir ../mijn-app --task "..."
 *
 * Creates branch builder/<run-id>, lets the agent work, commits the result on
 * that branch and writes the diff plus a run log to --out. Never pushes.
 *
 * --sandbox: install dependencies and run every check (including the build)
 * in a throwaway container without network or secrets. Needs Docker and the
 * dig-sandbox image (see sandbox/Dockerfile).
 *
 * Env: ANTHROPIC_API_KEY (or another SDK credential source),
 *      optional DIG_GATEWAY_URL + DIG_GATEWAY_TOKEN for the odoo_schema tool,
 *      optional DIG_SANDBOX_CA_BUNDLE for installs behind a TLS proxy.
 */

const { values } = parseArgs({
  options: {
    workdir: { type: 'string' },
    task: { type: 'string' },
    'task-file': { type: 'string' },
    run: { type: 'string' },
    out: { type: 'string', default: '.dig-builder-runs' },
    model: { type: 'string', default: DEFAULT_MODEL },
    effort: { type: 'string', default: 'high' },
    'max-turns': { type: 'string', default: '40' },
    'keep-branch': { type: 'boolean', default: false },
    sandbox: { type: 'boolean', default: false },
    checks: { type: 'string' },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const workdir = values.workdir ?? fail('--workdir is required')
let task = values.task
if (values['task-file']) {
  task = await readFile(values['task-file'], 'utf8')
}
if (!task?.trim()) fail('--task or --task-file is required')
const effort = values.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) fail('--effort must be low|medium|high|xhigh|max')
const maxTurns = Number(values['max-turns'])
if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) fail('--max-turns must be 1..200')

const runId = values.run ?? `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`
const outDir = path.resolve(values.out, runId)
const workspace = await Workspace.open(workdir)
if (outDir === workspace.root || outDir.startsWith(workspace.root + path.sep)) {
  fail('--out must be outside the working directory')
}

const customChecks = values.checks ? parseChecks(JSON.parse(await readFile(values.checks, 'utf8'))) : undefined
const sandbox = values.sandbox
  ? createSandbox({ cli: createDockerCli(), caBundle: process.env.DIG_SANDBOX_CA_BUNDLE || undefined })
  : null
const gatewayUrl = process.env.DIG_GATEWAY_URL
const gatewayToken = process.env.DIG_GATEWAY_TOKEN
const tools = {
  workspace,
  checks: sandbox
    ? createSandboxCheckRunner(workspace.root, sandbox, customChecks ?? SANDBOX_CHECKS)
    : createCheckRunner(workspace.root, customChecks ?? DEFAULT_CHECKS),
  odooSchema: gatewayUrl && gatewayToken ? createSchemaReader(gatewayUrl, gatewayToken) : undefined,
}

const started = await startBranch(workspace.root, branchName(runId))
console.error(`run ${runId}: branch ${started.branch} from ${started.base.slice(0, 7)}`)

let exitCode = 0
const log: unknown[] = []
try {
  if (sandbox) {
    console.error('  dependencies installeren in de sandbox...')
    const installed = await sandbox.install(workspace.root)
    if (!installed.ok) throw new Error(`installatie in de sandbox mislukt:\n${installed.output}`)
  }
  const result = await runAgent({
    client: new Anthropic(),
    tools,
    system: await buildSystemPrompt(workspace),
    task: task!,
    model: values.model,
    effort,
    maxTurns,
    onEvent(event) {
      log.push(event)
      if (event.type === 'tool') console.error(`  [${event.turn}] ${event.detail.name} ${event.detail.path ?? event.detail.check ?? ''} ${event.detail.ok ? 'ok' : 'FOUT'}`)
      else if (event.type === 'turn' && event.detail.stop !== 'tool_use') console.error(`  [${event.turn}] stop: ${event.detail.stop}`)
    },
  })
  const firstLine = task!.trim().split('\n')[0].slice(0, 60)
  const finished = await finishBranch(
    workspace.root,
    started,
    `DIG Builder: ${firstLine}\n\nRun ${runId}, status ${result.status}, ${result.turns} turns.`,
  )

  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'changes.diff'), finished.diff)
  await writeFile(
    path.join(outDir, 'run.json'),
    JSON.stringify(
      {
        runId,
        model: values.model,
        effort,
        status: result.status,
        turns: result.turns,
        usage: result.usage,
        sandbox: Boolean(sandbox),
        branch: started.branch,
        base: started.base,
        commit: finished.commit,
        excluded: finished.excluded,
        changedFiles: [...workspace.changed].sort(),
        summary: result.summary,
        events: log,
      },
      null,
      2,
    ),
  )

  console.log(`status:  ${result.status}`)
  console.log(`branch:  ${started.branch}${finished.commit ? ` @ ${finished.commit.slice(0, 7)}` : ' (geen wijzigingen)'}`)
  console.log(`output:  ${outDir}`)
  if (finished.stat) console.log(`\n${finished.stat.trimEnd()}`)
  console.log(`\n${result.summary}`)
  if (result.status !== 'done') exitCode = 2
  if (!finished.commit && !values['keep-branch']) {
    await git(workspace.root, ['switch', '-q', started.previous])
    await git(workspace.root, ['branch', '-q', '-D', started.branch])
  }
} catch (error) {
  exitCode = 1
  const reason = error instanceof Anthropic.APIError ? `Claude API ${error.status}: ${error.message}` : String(error)
  console.error(`run ${runId} afgebroken: ${reason}`)
  console.error(`de branch ${started.branch} blijft staan met eventuele niet-gecommitte wijzigingen`)
}
process.exit(exitCode)
