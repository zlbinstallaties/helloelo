import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Sandbox } from '../../sandbox/src/sandbox.ts'

/*
 * "Look at the running app": runs the project's probe command (dig-checks.json key `probe`, for
 * example `node scripts/probe.mjs`) with the paths the agent asks for appended after `--`.
 *
 * The probe builds the app, starts it against fake data and requests the paths; it needs no
 * network. It executes project code, so like the build and test checks it runs in the sandbox, or
 * on the host only when the user opted in (--checks / PROEFRUN_HOST_TESTS=1).
 */

export const MAX_PROBE_PATHS = 5
const PATH_PATTERN = /^\/[A-Za-z0-9_\-./?=&%:+,~]*$/
const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT_MS = 180_000

export interface ProbeResult {
  ok: boolean
  output: string
}

export type Probe = (paths: string[]) => Promise<ProbeResult>

/** Same rules as scripts/probe.mjs; checked here so the model gets the error without a container run. */
export function validateProbePath(value: string): string | null {
  if (value.length > 200 || value.startsWith('//') || !PATH_PATTERN.test(value)) {
    return `invalid path: ${value.slice(0, 80)} (use a path of the app itself, such as /api/dashboard?scope=all)`
  }
  return null
}

function tail(text: string) {
  return text.length > MAX_OUTPUT_CHARS ? `[... ingekort ...]\n${text.slice(-MAX_OUTPUT_CHARS)}` : text
}

export function createSandboxProbe(
  root: string,
  sandbox: Pick<Sandbox, 'exec'>,
  command: readonly [string, ...string[]],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Probe {
  return async (paths) => {
    const result = await sandbox.exec(root, [...command, '--', ...paths], { network: 'none', timeoutMs })
    return { ok: result.ok, output: result.timedOut ? `TIMED OUT\n${result.output}` : result.output }
  }
}

export function createHostProbe(root: string, command: readonly [string, ...string[]], timeoutMs = DEFAULT_TIMEOUT_MS): Probe {
  let home: string | null = null
  return async (paths) => {
    home ??= await mkdtemp(path.join(tmpdir(), 'dig-agent-home-'))
    const [file, ...args] = command
    const executable = file.includes('/') ? path.resolve(root, file) : file
    return new Promise((resolve) => {
      execFile(
        executable,
        [...args, '--', ...paths],
        { cwd: root, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home!, CI: '1', NO_COLOR: '1' } },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
          const spawnError = err && typeof err.code === 'string' ? `kon niet starten: ${err.code}\n` : ''
          resolve({ ok: !err, output: tail(`${spawnError}${err?.killed ? 'TIMED OUT\n' : ''}${stdout}${stderr}`.trim()) || '(geen uitvoer)' })
        },
      )
    })
  }
}
