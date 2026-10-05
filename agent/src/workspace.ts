import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

/*
 * File access for the agent, confined to one app working directory.
 *
 * Every path the model sends is untrusted. It is resolved against the root,
 * must stay inside it (also after following symlinks), and may not touch
 * git internals, dependencies or secret files.
 */

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

const DENIED_SEGMENTS = new Set(['.git', 'node_modules', '.wrangler', '.dev.db', 'dist', '.output'])
const DENIED_FILE = /^(\.env(\..*)?|.*\.(pem|key|p12|sqlite3?|db))$/i
const EXAMPLE_ENV = /^\.env\.example$/i
const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 512 * 1024
const MAX_LIST_ENTRIES = 2000

export interface WorkspaceLimits {
  maxReadBytes?: number
  maxWriteBytes?: number
}

export class Workspace {
  readonly root: string
  readonly changed = new Set<string>()
  private readonly maxReadBytes: number
  private readonly maxWriteBytes: number

  private constructor(root: string, limits: WorkspaceLimits) {
    this.root = root
    this.maxReadBytes = limits.maxReadBytes ?? MAX_READ_BYTES
    this.maxWriteBytes = limits.maxWriteBytes ?? MAX_WRITE_BYTES
  }

  static async open(root: string, limits: WorkspaceLimits = {}) {
    return new Workspace(await realpath(root), limits)
  }

  /** Lexical check plus denylist; returns the absolute and relative path. */
  private check(input: string) {
    if (typeof input !== 'string' || input.length === 0 || input.length > 500 || input.includes('\0')) {
      throw new WorkspaceError('invalid path')
    }
    if (path.isAbsolute(input)) throw new WorkspaceError('use a path relative to the project root')
    const absolute = path.resolve(this.root, input)
    const relative = path.relative(this.root, absolute)
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkspaceError('path escapes the project root')
    }
    const segments = relative.split(path.sep)
    if (segments.some((s) => DENIED_SEGMENTS.has(s))) throw new WorkspaceError(`access denied: ${relative}`)
    const name = segments[segments.length - 1]
    if (DENIED_FILE.test(name) && !EXAMPLE_ENV.test(name)) throw new WorkspaceError(`access denied: ${relative}`)
    return { absolute, relative: segments.join('/') }
  }

  /** Follows symlinks of the deepest existing ancestor and re-checks containment. */
  private async contained(absolute: string) {
    let probe = absolute
    for (;;) {
      try {
        const real = await realpath(probe)
        const rel = path.relative(this.root, real)
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          throw new WorkspaceError('path escapes the project root')
        }
        return
      } catch (error) {
        if (error instanceof WorkspaceError) throw error
        const parent = path.dirname(probe)
        if (parent === probe) throw new WorkspaceError('path escapes the project root')
        probe = parent
      }
    }
  }

  async listFiles(dir = '.'): Promise<string[]> {
    const start = dir === '.' || dir === '' ? this.root : this.check(dir).absolute
    await this.contained(start)
    const out: string[] = []
    const walk = async (current: string) => {
      const entries = await readdir(current, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (out.length >= MAX_LIST_ENTRIES) return
        if (DENIED_SEGMENTS.has(entry.name) || entry.isSymbolicLink()) continue
        const full = path.join(current, entry.name)
        const rel = path.relative(this.root, full).split(path.sep).join('/')
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile() && !(DENIED_FILE.test(entry.name) && !EXAMPLE_ENV.test(entry.name))) out.push(rel)
      }
    }
    await walk(start)
    return out
  }

  async readFile(input: string): Promise<string> {
    const { absolute, relative } = this.check(input)
    await this.contained(absolute)
    const info = await lstat(absolute).catch(() => null)
    if (!info || !info.isFile()) throw new WorkspaceError(`file not found: ${relative}`)
    if (info.size > this.maxReadBytes) throw new WorkspaceError(`file too large to read: ${relative}`)
    return readFile(absolute, 'utf8')
  }

  async writeFile(input: string, contents: string): Promise<void> {
    const { absolute, relative } = this.check(input)
    if (Buffer.byteLength(contents, 'utf8') > this.maxWriteBytes) {
      throw new WorkspaceError(`contents too large: ${relative}`)
    }
    await this.contained(absolute)
    const info = await lstat(absolute).catch(() => null)
    if (info && !info.isFile()) throw new WorkspaceError(`not a regular file: ${relative}`)
    await mkdir(path.dirname(absolute), { recursive: true })
    await this.contained(path.dirname(absolute))
    await writeFile(absolute, contents, 'utf8')
    this.changed.add(relative)
  }

  /** Replaces exactly one occurrence of `oldText`. */
  async editFile(input: string, oldText: string, newText: string): Promise<void> {
    if (oldText.length === 0) throw new WorkspaceError('old_text must not be empty')
    const current = await this.readFile(input)
    const first = current.indexOf(oldText)
    if (first === -1) throw new WorkspaceError('old_text not found; read the file again and copy it exactly')
    if (current.indexOf(oldText, first + 1) !== -1) {
      throw new WorkspaceError('old_text occurs more than once; include more surrounding lines')
    }
    await this.writeFile(input, current.slice(0, first) + newText + current.slice(first + oldText.length))
  }
}
