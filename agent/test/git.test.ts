import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { finishBranch, git, startBranch } from '../src/git.ts'
import { tempProject } from './helpers.ts'

async function repo() {
  const root = await tempProject({ 'app.ts': 'export const a = 1\n' })
  await git(root, ['init', '-q', '-b', 'master'])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  return root
}

test('branch names are restricted to builder/*', async () => {
  const root = await repo()
  for (const name of ['master', 'main', 'feature/x', 'builder/', 'builder/../master', 'builder/A B']) {
    await assert.rejects(startBranch(root, name), /builder\//, name)
  }
})

test('refuses a dirty working tree', async () => {
  const root = await repo()
  await writeFile(path.join(root, 'app.ts'), 'changed')
  await assert.rejects(startBranch(root, 'builder/run-1'), /not clean/)
})

test('commits on the run branch, returns the diff, master untouched, hooks off', async () => {
  const root = await repo()
  await mkdir(path.join(root, '.git/hooks'), { recursive: true })
  const marker = path.join(root, 'hook-ran')
  for (const hook of ['pre-commit', 'post-commit', 'commit-msg']) {
    await writeFile(path.join(root, '.git/hooks', hook), `#!/bin/sh\ntouch ${marker}\n`)
    await chmod(path.join(root, '.git/hooks', hook), 0o755)
  }
  const run = await startBranch(root, 'builder/run-1')
  await writeFile(path.join(root, 'app.ts'), 'export const a = 2\n')
  await writeFile(path.join(root, 'new.ts'), 'export {}\n')
  const done = await finishBranch(root, run, 'DIG Builder: test')
  assert.ok(done.commit)
  assert.match(done.diff, /-export const a = 1/)
  assert.match(done.diff, /\+\+\+ b\/new.ts/)
  assert.match(done.stat, /2 files changed/)
  assert.equal(existsSync(marker), false, 'repository hooks must not run')
  assert.equal((await git(root, ['rev-parse', 'master'])).trim(), run.base)
  assert.match(await git(root, ['log', '-1', '--format=%an']), /DIG Builder/)
})

test('no changes means no commit', async () => {
  const root = await repo()
  const run = await startBranch(root, 'builder/run-2')
  assert.deepEqual(await finishBranch(root, run, 'x'), { commit: null, stat: '', diff: '', excluded: [] })
})

test('generated directories are never committed', async () => {
  const root = await repo()
  const run = await startBranch(root, 'builder/run-3')
  await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true })
  await writeFile(path.join(root, 'node_modules/pkg/index.js'), 'x')
  await mkdir(path.join(root, 'web/dist'), { recursive: true })
  await writeFile(path.join(root, 'web/dist/app.js'), 'x')
  await writeFile(path.join(root, 'distance.ts'), 'export {}\n')
  const done = await finishBranch(root, run, 'x')
  assert.deepEqual(done.excluded.sort(), ['node_modules', 'web/dist'])
  const files = (await git(root, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n')
  assert.deepEqual(files, ['distance.ts'])
})
