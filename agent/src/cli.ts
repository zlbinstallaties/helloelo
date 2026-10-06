import Anthropic from '@anthropic-ai/sdk'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { DEFAULT_MODEL } from './loop.ts'
import { EFFORTS, executeRun, type Effort } from './run.ts'

/*
 * One builder run on a local app checkout:
 *
 *   node --experimental-strip-types agent/src/cli.ts --workdir ../mijn-app --task "..."
 *
 * Creates branch builder/<run-id>, lets the agent work, commits the result on
 * that branch and writes the diff plus a run log to --out. Never pushes.
 *
 * --sandbox: install dependencies and run every check (including the build)
 * in a throwaway container without network or secrets. A dig-checks.json in
 * the project (named checks such as test and build) is used in this mode. Needs Docker and the
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
    'max-cost-usd': { type: 'string', default: '5' },
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
const task = values['task-file'] ? await readFile(values['task-file'], 'utf8') : values.task
if (!task?.trim()) fail('--task or --task-file is required')
if (!EFFORTS.includes(values.effort as Effort)) fail('--effort must be low|medium|high|xhigh|max')

const gatewayUrl = process.env.DIG_GATEWAY_URL
const gatewayToken = process.env.DIG_GATEWAY_TOKEN

let exitCode = 0
try {
  const result = await executeRun({
    workdir,
    task,
    outDir: values.out!,
    runId: values.run,
    model: values.model,
    effort: values.effort as Effort,
    maxTurns: Number(values['max-turns']),
    maxCostUsd: Number(values['max-cost-usd']),
    sandbox: values.sandbox,
    checksFile: values.checks,
    gateway: gatewayUrl && gatewayToken ? { url: gatewayUrl, token: gatewayToken } : undefined,
    caBundle: process.env.DIG_SANDBOX_CA_BUNDLE || undefined,
    keepBranch: values['keep-branch'],
    onEvent(event) {
      if (event.type === 'phase' && event.detail.phase === 'branch') console.error(`run: branch ${event.detail.branch} from ${String(event.detail.base).slice(0, 7)}`)
      else if (event.type === 'phase' && event.detail.phase === 'install') console.error('  dependencies installeren in de sandbox...')
      else if (event.type === 'tool') console.error(`  [${event.turn}] ${event.detail.name} ${event.detail.path ?? event.detail.check ?? (Array.isArray(event.detail.paths) ? event.detail.paths.join(' ') : '')} ${event.detail.ok ? 'ok' : 'FOUT'}`)
      else if (event.type === 'turn' && event.detail.stop !== 'tool_use') console.error(`  [${event.turn}] stop: ${event.detail.stop}`)
    },
  })

  if (result.status === 'error') {
    exitCode = 1
    console.error(`run ${result.runId} afgebroken: ${result.error}`)
    console.error(`de branch ${result.branch} blijft staan met eventuele niet-gecommitte wijzigingen`)
  } else {
    console.log(`status:  ${result.status}`)
    console.log(`branch:  ${result.branch}${result.commit ? ` @ ${result.commit.slice(0, 7)}` : ' (geen wijzigingen)'}`)
    console.log(`kosten:  ca. $${result.estimatedCostUsd.toFixed(2)} (schatting, limiet $${values['max-cost-usd']})`)
    console.log(`output:  ${result.runDir}`)
    if (result.stat) console.log(`\n${result.stat.trimEnd()}`)
    console.log(`\n${result.summary}`)
    if (result.status !== 'done') exitCode = 2
  }
} catch (error) {
  exitCode = 1
  console.error(error instanceof Anthropic.APIError ? `Claude API ${error.status}: ${error.message}` : error instanceof Error ? error.message : String(error))
}
process.exit(exitCode)
