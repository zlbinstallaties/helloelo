import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHostProbe, createSandboxProbe, validateProbePath } from '../src/probe.ts'
import { createCheckRunner } from '../src/checks.ts'
import { executeTool, toolDefinitions } from '../src/tools.ts'
import { Workspace } from '../src/workspace.ts'
import { tempProject } from './helpers.ts'

async function context(probe?: (paths: string[]) => Promise<{ ok: boolean; output: string }>) {
  const ws = await Workspace.open(await tempProject({ 'a.txt': 'x' }))
  return { workspace: ws, checks: createCheckRunner(ws.root, { ok: ['/bin/true'] }), probe }
}

test('path validation accepts app paths and refuses everything else', () => {
  for (const ok of ['/', '/api/health', '/api/dashboard?scope=all&technician=Jan%20de%20Vries', '/a/b.c-d_e~f']) {
    assert.equal(validateProbePath(ok), null, ok)
  }
  for (const bad of ['api/health', 'http://evil.example/', '//evil.example', '/a b', '/a;rm', '/a`x`', '/$(x)', '/' + 'a'.repeat(250), '']) {
    assert.match(validateProbePath(bad) ?? '', /invalid path/, bad)
  }
})

test('probe_app is only offered when the project has a probe', async () => {
  const without = toolDefinitions(await context())
  const withProbe = toolDefinitions(await context(async () => ({ ok: true, output: '' })))
  assert.ok(!without.some((t) => t.name === 'probe_app'))
  assert.ok(withProbe.some((t) => t.name === 'probe_app'))
  assert.deepEqual((await executeTool(await context(), 'probe_app', { paths: ['/'] })).content, 'unknown tool: probe_app')
})

test('probe_app validates its input before anything runs and reports failures as errors', async () => {
  const calls: string[][] = []
  const ctx = await context(async (paths) => {
    calls.push(paths)
    return paths[0] === '/boom' ? { ok: false, output: 'build failed' } : { ok: true, output: `### GET ${paths[0]} -> 200` }
  })
  for (const input of [{}, { paths: [] }, { paths: ['/a', '/b', '/c', '/d', '/e', '/f'] }, { paths: [1] }, { paths: ['/'], extra: 1 }, { paths: ['http://x'] }]) {
    const result = await executeTool(ctx, 'probe_app', input)
    assert.equal(result.isError, true, JSON.stringify(input))
  }
  assert.deepEqual(calls, [])
  const good = await executeTool(ctx, 'probe_app', { paths: ['/api/health', '/x'] })
  assert.deepEqual([good.isError, good.content], [false, '### GET /api/health -> 200'])
  const failed = await executeTool(ctx, 'probe_app', { paths: ['/boom'] })
  assert.deepEqual([failed.isError, failed.content], [true, 'probe failed:\nbuild failed'])
})

test('the sandbox probe appends the paths after -- and runs without network', async () => {
  const calls: unknown[] = []
  const probe = createSandboxProbe('/srv/app', { async exec(root, command, opts) { calls.push({ root, command, opts }); return { ok: true, exitCode: 0, timedOut: false, output: 'ok' } } }, ['node', 'scripts/probe.mjs'])
  assert.deepEqual(await probe(['/a', '/b']), { ok: true, output: 'ok' })
  assert.deepEqual(calls, [{ root: '/srv/app', command: ['node', 'scripts/probe.mjs', '--', '/a', '/b'], opts: { network: 'none', timeoutMs: 180_000 } }])
  const slow = createSandboxProbe('/srv/app', { async exec() { return { ok: false, exitCode: null, timedOut: true, output: 'partial' } } }, ['node', 'x'])
  assert.deepEqual(await slow(['/a']), { ok: false, output: 'TIMED OUT\npartial' })
})

test('the host probe passes the paths, keeps secrets out of the environment and reports failures', async () => {
  const root = await tempProject()
  await writeFile(path.join(root, 'probe.sh'), '#!/bin/sh\necho "args: $@"\nenv | grep -c KEY || true\nexit ${PROBE_EXIT:-0}\n')
  await chmod(path.join(root, 'probe.sh'), 0o755)
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak'
  const result = await createHostProbe(root, ['./probe.sh'])(['/a', '/b?x=1'])
  assert.equal(result.ok, true)
  assert.match(result.output, /args: -- \/a \/b\?x=1/)
  assert.match(result.output, /\n0$/, 'no variable with KEY in its name reaches the probe')
  const missing = await createHostProbe(root, ['./nope.sh'])(['/a'])
  assert.equal(missing.ok, false)
  assert.match(missing.output, /kon niet starten: ENOENT/)
  await writeFile(path.join(root, 'slow.sh'), '#!/bin/sh\nsleep 5\n')
  await chmod(path.join(root, 'slow.sh'), 0o755)
  const slow = await createHostProbe(root, ['./slow.sh'], 200)(['/a'])
  assert.deepEqual([slow.ok, slow.output.startsWith('TIMED OUT')], [false, true])
})
