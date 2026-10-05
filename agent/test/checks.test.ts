import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { createCheckRunner, createSandboxCheckRunner, parseChecks } from '../src/checks.ts'
import { tempProject } from './helpers.ts'

test('runs only named checks, without secrets in the environment', async () => {
  const root = await tempProject({ 'bin/env.sh': '#!/bin/sh\nenv\n', 'bin/fail.sh': '#!/bin/sh\necho broken >&2\nexit 3\n' })
  await chmod(path.join(root, 'bin/env.sh'), 0o755)
  await chmod(path.join(root, 'bin/fail.sh'), 0o755)
  process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-leak'
  const runner = createCheckRunner(root, { env: ['bin/env.sh'], fail: ['bin/fail.sh'] })
  assert.deepEqual(runner.names, ['env', 'fail'])
  const env = await runner.run('env')
  assert.equal(env.ok, true)
  assert.ok(!env.output.includes('sk-test-should-not-leak'))
  assert.match(env.output, /CI=1/)
  const failed = await runner.run('fail')
  assert.equal(failed.ok, false)
  assert.equal(failed.exitCode, 3)
  assert.match(failed.output, /broken/)
  await assert.rejects(runner.run('rm -rf /'), /unknown check/)
  await assert.rejects(runner.run('constructor'), /unknown check/)
})

test('timeouts are reported', async () => {
  const root = await tempProject({ 'bin/slow.sh': '#!/bin/sh\nsleep 5\n' })
  await chmod(path.join(root, 'bin/slow.sh'), 0o755)
  const result = await createCheckRunner(root, { slow: ['bin/slow.sh'] }, 200).run('slow')
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

test('missing binary is a failed check, not a crash', async () => {
  const root = await tempProject()
  const result = await createCheckRunner(root).run('typecheck')
  assert.equal(result.ok, false)
  assert.match(result.output, /kon niet starten: ENOENT/)
})

test('sandbox runner sends the named command to a network-less sandbox', async () => {
  const calls: unknown[] = []
  const runner = createSandboxCheckRunner('/srv/app', {
    async exec(root, command, opts) {
      calls.push({ root, command, opts })
      return { ok: false, exitCode: 1, timedOut: false, output: 'error TS1' }
    },
  })
  assert.deepEqual(runner.names, ['typecheck', 'lint', 'build'])
  assert.deepEqual(await runner.run('build'), { name: 'build', ok: false, exitCode: 1, timedOut: false, output: 'error TS1' })
  assert.deepEqual(calls, [{ root: '/srv/app', command: ['node_modules/.bin/vite', 'build'], opts: { network: 'none', timeoutMs: 300_000 } }])
  await assert.rejects(runner.run('deploy'), /unknown check/)
})

test('checks file is validated', () => {
  assert.deepEqual(parseChecks({ test: ['bun', 'test'] }), { test: ['bun', 'test'] })
  assert.throws(() => parseChecks({ 'Bad Name': ['x'] }), /invalid check name/)
  assert.throws(() => parseChecks({ test: 'bun test' }), /list of strings/)
  assert.throws(() => parseChecks({ test: [] }), /list of strings/)
  assert.throws(() => parseChecks({}), /no checks/)
  assert.throws(() => parseChecks([]), /object/)
})
