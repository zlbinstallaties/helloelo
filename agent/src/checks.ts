import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Sandbox } from '../../sandbox/src/sandbox.ts'

/*
 * Named checks the agent may run. The model picks a name, never a command.
 *
 * On the host (no sandbox) the defaults only run tools that read the project
 * without executing its code (tsc, oxlint without --fix), with a scrubbed
 * environment. Checks that execute project code (vite build, tests) run only
 * through the sandbox: a throwaway container without network or secrets.
 */

export type CheckCommands = Readonly<Record<string, readonly [string, ...string[]]>>

export const DEFAULT_CHECKS: CheckCommands = {
  typecheck: ['node_modules/.bin/tsc', '--noEmit', '--pretty', 'false'],
  lint: ['node_modules/.bin/oxlint'],
}

/** Checks for sandbox mode; these may execute project code. */
export const SANDBOX_CHECKS: CheckCommands = {
  ...DEFAULT_CHECKS,
  build: ['node_modules/.bin/vite', 'build'],
}

export interface CheckResult {
  name: string
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  output: string
}

const MAX_OUTPUT_CHARS = 20_000
const DEFAULT_TIMEOUT_MS = 120_000

function tail(text: string) {
  return text.length > MAX_OUTPUT_CHARS ? `[... ingekort ...]\n${text.slice(-MAX_OUTPUT_CHARS)}` : text
}

export function createCheckRunner(root: string, checks: CheckCommands = DEFAULT_CHECKS, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let home: string | null = null

  return {
    names: Object.keys(checks),
    async run(name: string): Promise<CheckResult> {
      const command = Object.hasOwn(checks, name) ? checks[name] : undefined
      if (!command) throw new Error(`unknown check: ${name}`)
      home ??= await mkdtemp(path.join(tmpdir(), 'dig-agent-home-'))
      const [file, ...args] = command
      const executable = file.includes('/') ? path.resolve(root, file) : file
      return new Promise((resolve) => {
        execFile(
          executable,
          args,
          {
            cwd: root,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home!, CI: '1', NO_COLOR: '1' },
          },
          (error, stdout, stderr) => {
            const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
            const timedOut = Boolean(err?.killed)
            const exitCode = err ? (typeof err.code === 'number' ? err.code : null) : 0
            const spawnError = err && typeof err.code === 'string' ? `kon niet starten: ${err.code}\n` : ''
            resolve({
              name,
              ok: !err,
              exitCode,
              timedOut,
              output: tail(`${spawnError}${stdout}${stderr}`.trim()) || '(geen uitvoer)',
            })
          },
        )
      })
    },
  }
}

export type CheckRunner = ReturnType<typeof createCheckRunner>

/** Same interface, but every check runs in a fresh sandbox container. */
export function createSandboxCheckRunner(
  root: string,
  sandbox: Pick<Sandbox, 'exec'>,
  checks: CheckCommands = SANDBOX_CHECKS,
  timeoutMs = 300_000,
): CheckRunner {
  return {
    names: Object.keys(checks),
    async run(name: string): Promise<CheckResult> {
      const command = Object.hasOwn(checks, name) ? checks[name] : undefined
      if (!command) throw new Error(`unknown check: ${name}`)
      const result = await sandbox.exec(root, command, { network: 'none', timeoutMs })
      return { name, ...result }
    },
  }
}

/** Validates a checks file: {"name": ["command", "arg", ...]}. */
export function parseChecks(raw: unknown): CheckCommands {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('checks must be an object')
  const checks: Record<string, [string, ...string[]]> = {}
  for (const [name, command] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`invalid check name: ${name}`)
    if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === 'string' && c.length > 0)) {
      throw new Error(`check ${name} must be a non-empty list of strings`)
    }
    checks[name] = command as [string, ...string[]]
  }
  if (Object.keys(checks).length === 0) throw new Error('no checks defined')
  return checks
}
