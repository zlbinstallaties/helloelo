import { execFile } from 'node:child_process'

/*
 * Git around one agent run: start a fresh `builder/...` branch from the
 * current HEAD, and afterwards commit what changed and return the diff.
 *
 * Never pushes. Never commits on main/master. Repository hooks are disabled
 * for every git call so a run cannot execute code through them.
 */

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

const BRANCH_PATTERN = /^builder\/[a-z0-9][a-z0-9._-]{0,80}$/
const PROTECTED = new Set(['main', 'master'])
const SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false']

export function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
        // No API keys in the environment of child processes.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(`git ${args[0]} failed: ${stderr.trim() || error.message}`))
        else resolve(stdout)
      },
    )
  })
}

export function branchName(runId: string) {
  return `builder/${runId}`
}

export interface StartedRun {
  branch: string
  base: string
  previous: string
}

export async function startBranch(root: string, branch: string): Promise<StartedRun> {
  if (!BRANCH_PATTERN.test(branch) || PROTECTED.has(branch)) {
    throw new GitError(`branch must look like builder/<name>: ${branch}`)
  }
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  if (!top) throw new GitError('not a git repository')
  if ((await git(root, ['status', '--porcelain'])).trim()) {
    throw new GitError('working tree is not clean; commit or stash first')
  }
  const previous = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const base = (await git(root, ['rev-parse', 'HEAD'])).trim()
  await git(root, ['switch', '-c', branch])
  return { branch, base, previous }
}

export interface FinishedRun {
  commit: string | null
  stat: string
  diff: string
  /** Generated paths that were left out of the commit. */
  excluded: string[]
}

/** Never committed, even when a project forgot to ignore them. */
const GENERATED = /(^|\/)(node_modules|dist|\.output|\.wrangler|\.vite|\.turbo|coverage)(\/|$)/

export async function finishBranch(root: string, run: StartedRun, message: string): Promise<FinishedRun> {
  const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (current !== run.branch) throw new GitError(`expected to be on ${run.branch}, found ${current}`)
  await git(root, ['add', '-A'])
  const staged = (await git(root, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
  // Unstage whole generated directories (back to HEAD), not file by file.
  const excluded = [
    ...new Set(
      staged.flatMap((file) => {
        const match = GENERATED.exec(file)
        return match ? [file.slice(0, match.index + match[1].length + match[2].length)] : []
      }),
    ),
  ]
  if (excluded.length) await git(root, ['reset', '-q', '--', ...excluded])
  if (!(await git(root, ['diff', '--cached', '--name-only'])).trim()) {
    return { commit: null, stat: '', diff: '', excluded }
  }
  await git(root, [
    '-c', 'user.name=DIG Builder',
    '-c', 'user.email=dig-builder@localhost',
    'commit', '--no-verify', '-q', '-m', message,
  ])
  const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const stat = await git(root, ['diff', '--stat', run.base, commit])
  const diff = await git(root, ['diff', run.base, commit])
  return { commit, stat, diff, excluded }
}
