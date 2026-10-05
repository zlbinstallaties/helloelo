import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Workspace, WorkspaceError } from '../src/workspace.ts'
import { tempProject } from './helpers.ts'

async function project() {
  const root = await tempProject({
    'src/app.ts': 'export const a = 1\n',
    '.env': 'SECRET=1',
    '.env.example': 'SECRET=',
    '.git/config': '[core]',
    'node_modules/x/index.js': '',
    'README.md': '# app',
  })
  return Workspace.open(root)
}

test('listFiles hides git, dependencies and secrets', async () => {
  const ws = await project()
  assert.deepEqual(await ws.listFiles(), ['.env.example', 'README.md', 'src/app.ts'])
  assert.deepEqual(await ws.listFiles('src'), ['src/app.ts'])
})

test('paths cannot escape the root or reach denied files', async () => {
  const ws = await project()
  for (const bad of ['../outside.txt', '/etc/passwd', 'src/../../x', '.env', '.git/config', 'node_modules/x/index.js', 'src/key.pem', '', 'a\0b']) {
    await assert.rejects(ws.readFile(bad), WorkspaceError, bad)
    await assert.rejects(ws.writeFile(bad, 'x'), WorkspaceError, bad)
  }
  assert.equal(await ws.readFile('.env.example'), 'SECRET=')
})

test('symlinks pointing outside the root are refused', async () => {
  const ws = await project()
  const outside = await tempProject({ 'secret.txt': 'top secret' })
  await symlink(outside, path.join(ws.root, 'linked'))
  await symlink(path.join(outside, 'secret.txt'), path.join(ws.root, 'secret-link.txt'))
  await assert.rejects(ws.readFile('linked/secret.txt'), /escapes/)
  await assert.rejects(ws.writeFile('linked/new.txt', 'x'), /escapes/)
  await assert.rejects(ws.readFile('secret-link.txt'), /escapes/)
  assert.ok(!(await ws.listFiles()).some((f) => f.startsWith('linked') || f === 'secret-link.txt'))
})

test('write creates directories and records the change', async () => {
  const ws = await project()
  await ws.writeFile('src/new/file.ts', 'x')
  assert.equal(await readFile(path.join(ws.root, 'src/new/file.ts'), 'utf8'), 'x')
  assert.deepEqual([...ws.changed], ['src/new/file.ts'])
})

test('edit needs exactly one match', async () => {
  const ws = await project()
  await ws.editFile('src/app.ts', 'a = 1', 'a = 2')
  assert.equal(await ws.readFile('src/app.ts'), 'export const a = 2\n')
  await writeFile(path.join(ws.root, 'twice.txt'), 'x x')
  await assert.rejects(ws.editFile('twice.txt', 'x', 'y'), /more than once/)
  await assert.rejects(ws.editFile('src/app.ts', 'nope', 'y'), /not found/)
  await assert.rejects(ws.editFile('src/app.ts', '', 'y'), /empty/)
})

test('size limits apply', async () => {
  const root = await tempProject({ 'big.txt': 'x'.repeat(2000) })
  const ws = await Workspace.open(root, { maxReadBytes: 1000, maxWriteBytes: 1000 })
  await assert.rejects(ws.readFile('big.txt'), /too large/)
  await assert.rejects(ws.writeFile('new.txt', 'x'.repeat(1001)), /too large/)
  await mkdir(path.join(root, 'dir'))
  await assert.rejects(ws.writeFile('dir', 'x'), /not a regular file/)
})
