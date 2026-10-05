import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { createCheckRunner } from '../src/checks.ts'
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
