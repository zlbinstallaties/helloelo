import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/*
 * Everything the installer does to the machine goes through this interface, so tests can run the
 * whole installer against a fake and look at exactly which commands and files it would touch.
 */

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Run as this user (via runuser) instead of as the installer's user. */
  user?: string
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export interface WriteOptions {
  mode?: number
  /** "user:group", applied with chown. */
  owner?: string
  /** Overwrite the existing file itself (same inode): needed for a file that is bind-mounted into a container. */
  inPlace?: boolean
}

export interface Sys {
  run(cmd: string, args: string[], options?: RunOptions): Promise<RunResult>
  read(file: string): Promise<string | null>
  write(file: string, content: string, options?: WriteOptions): Promise<void>
  exists(file: string): Promise<boolean>
  mkdir(dir: string, options?: WriteOptions): Promise<void>
  remove(file: string): Promise<void>
  /** HTTP status of a GET, or null when nothing answered. Does not follow redirects. */
  http(url: string, timeoutMs?: number): Promise<number | null>
  sleep(ms: number): Promise<void>
  now(): Date
  log(message: string): void
}

export function realSys(log: (message: string) => void = (message) => console.log(message)): Sys {
  async function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const [file, argv] = options.user ? ['runuser', ['-u', options.user, '--', cmd, ...args]] : [cmd, args]
    return new Promise((resolve) => {
      execFile(
        file,
        argv,
        { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, ...options.env, LC_ALL: 'C' } },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 127) : 0
          resolve({ code, stdout: String(stdout), stderr: error && code === 127 && !stderr ? String(error.message) : String(stderr) })
        },
      )
    })
  }

  async function applyOwner(file: string, options: WriteOptions) {
    if (options.mode !== undefined) await chmod(file, options.mode)
    if (options.owner) {
      const result = await run('chown', [options.owner, file])
      if (result.code !== 0) throw new Error(`chown ${options.owner} ${file}: ${result.stderr.trim()}`)
    }
  }

  return {
    run,
    async read(file) {
      try {
        return await readFile(file, 'utf8')
      } catch {
        return null
      }
    },
    async write(file, content, options = {}) {
      if (options.inPlace) {
        // Same file, same permissions and owner; replacing it would break a single-file bind mount.
        await writeFile(file, content)
        return
      }
      await mkdir(path.dirname(file), { recursive: true })
      const temp = `${file}.dig-tmp`
      // Secrets must never be readable, not even for a moment: create with the final mode.
      await writeFile(temp, content, { mode: options.mode ?? 0o644 })
      await applyOwner(temp, options)
      await rename(temp, file)
    },
    async exists(file) {
      try {
        await stat(file)
        return true
      } catch {
        return false
      }
    },
    async mkdir(dir, options = {}) {
      await mkdir(dir, { recursive: true })
      await applyOwner(dir, options)
    },
    async remove(file) {
      await rm(file, { recursive: true, force: true })
    },
    async http(url, timeoutMs = 8000) {
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
        await response.arrayBuffer().catch(() => {})
        return response.status
      } catch {
        return null
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    log,
  }
}
