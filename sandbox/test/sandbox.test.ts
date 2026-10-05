import test from 'node:test'
import assert from 'node:assert/strict'
import { chown, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DockerCli, DockerResult } from '../src/docker.ts'
import { createSandbox, ownerOf, runArgs } from '../src/sandbox.ts'

const base = { name: 'dig-exec-1', workdir: '/srv/app', user: '1000:1000', network: 'none' as const, command: ['bun', 'test'] }

function flag(args: string[], name: string) {
  return args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
}

test('every container is hardened', () => {
  const args = runArgs(base)
  for (const f of ['--rm', '--init', '--read-only']) assert.ok(args.includes(f), f)
  assert.deepEqual(flag(args, '--cap-drop'), ['ALL'])
  assert.deepEqual(flag(args, '--security-opt'), ['no-new-privileges'])
  assert.deepEqual(flag(args, '--network'), ['none'])
  assert.deepEqual(flag(args, '--user'), ['1000:1000'])
  assert.deepEqual(flag(args, '--memory'), flag(args, '--memory-swap'))
  assert.ok(flag(args, '--pids-limit')[0])
  assert.deepEqual(flag(args, '--volume'), ['/srv/app:/work:rw'])
  assert.deepEqual(args.slice(-3), ['dig-sandbox:1', 'bun', 'test'])
  assert.ok(!args.some((a) => a.includes('docker.sock')))
  assert.deepEqual(flag(runArgs({ ...base, network: 'registry' }), '--network'), ['bridge'])
  assert.deepEqual(flag(runArgs({ ...base, network: { internal: 'dig-preview' } }), '--network'), ['dig-preview'])
})

test('root, bad names and secrets are refused', () => {
  assert.throws(() => runArgs({ ...base, user: '0:0' }), /non-root/)
  assert.throws(() => runArgs({ ...base, user: 'root' }), /non-root/)
  assert.throws(() => runArgs({ ...base, name: '--privileged' }), /invalid container name/)
  for (const key of ['ODOO_API_KEY', 'ANTHROPIC_API_KEY', 'PREVIEW_SESSION_SECRET', 'DB_PASSWORD']) {
    assert.throws(() => runArgs({ ...base, env: { [key]: 'x' } }), /secret env/, key)
  }
  assert.throws(() => runArgs({ ...base, env: { 'A=B': 'x' } }), /invalid env/)
  assert.ok(runArgs({ ...base, env: { DIG_GATEWAY_TOKEN: 't', DIG_GATEWAY_URL: 'u' } }).includes('DIG_GATEWAY_TOKEN=t'))
  assert.throws(() => runArgs({ ...base, readOnlyFiles: { '/x': '/work/ca.pem' } }), /read-only mount/)
})

test('project directory must not be owned by root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-sb-'))
  if (process.getuid?.() === 0) {
    await assert.rejects(ownerOf(dir), /owned by root/)
    await chown(dir, 1000, 1000)
  }
  const owner = await ownerOf(dir)
  assert.match(owner.user, /^[1-9]\d*:\d+$/)
})

function fakeCli(results: Partial<DockerResult>[]) {
  const calls: string[][] = []
  const cli: DockerCli = {
    async run(args) {
      calls.push(args)
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...results.shift() }
    },
  }
  return { cli, calls }
}

async function ownedDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-sb-'))
  if (process.getuid?.() === 0) await chown(dir, 1000, 1000)
  return dir
}

test('exec reports output, and removes the container after a timeout', async () => {
  const dir = await ownedDir()
  const ok = fakeCli([{ stdout: 'built\n' }])
  const result = await createSandbox({ cli: ok.cli }).exec(dir, ['vite', 'build'])
  assert.deepEqual(result, { ok: true, exitCode: 0, timedOut: false, output: 'built' })

  const slow = fakeCli([{ code: null, timedOut: true }])
  const timedOut = await createSandbox({ cli: slow.cli }).exec(dir, ['sleep', '999'], { timeoutMs: 10 })
  assert.equal(timedOut.ok, false)
  const name = flag(slow.calls[0], '--name')[0]
  assert.deepEqual(slow.calls[1], ['rm', '-f', name])
})

test('install uses the registry network without lifecycle scripts; CA only there', async () => {
  const dir = await ownedDir()
  const { cli, calls } = fakeCli([{}, {}])
  const sandbox = createSandbox({ cli, caBundle: '/etc/ssl/proxy-ca.pem' })
  await sandbox.install(dir)
  await sandbox.exec(dir, ['vite', 'build'])
  assert.deepEqual(flag(calls[0], '--network'), ['bridge'])
  assert.deepEqual(calls[0].slice(-4), ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'])
  assert.deepEqual(flag(calls[0], '--mount'), ['type=bind,source=/etc/ssl/proxy-ca.pem,target=/etc/dig-ca.pem,readonly'])
  assert.ok(calls[0].includes('NODE_EXTRA_CA_CERTS=/etc/dig-ca.pem'))
  assert.deepEqual(flag(calls[1], '--network'), ['none'])
  assert.deepEqual(flag(calls[1], '--mount'), [])
})
