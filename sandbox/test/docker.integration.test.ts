import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chown, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDockerCli } from '../src/docker.ts'
import { containerName, createPreviewManager } from '../src/preview.ts'
import { createSandbox, SANDBOX_IMAGE } from '../src/sandbox.ts'

/*
 * Runs against a real Docker daemon with the dig-sandbox image built.
 * Skipped when either is missing.
 */

function dockerReady() {
  try {
    execFileSync('docker', ['image', 'inspect', SANDBOX_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const skip = dockerReady() ? false : 'docker or the dig-sandbox image is not available'
const cli = createDockerCli()

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-int-'))
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(dir, name), contents)
  if (process.getuid?.() === 0) execFileSync('chown', ['-R', '1000:1000', dir])
  else await chown(dir, process.getuid!(), process.getgid!())
  return dir
}

const PROBE = `
const fs = require('fs')
const out = { uid: process.getuid(), env: Object.keys(process.env).sort() }
try { fs.writeFileSync('/etc/x', '1'); out.rootWritable = true } catch { out.rootWritable = false }
fs.writeFileSync('/work/written.txt', 'ok'); out.workWritable = true
fetch('https://registry.npmjs.org/').then(() => { out.network = true }, () => { out.network = false })
  .finally(() => console.log(JSON.stringify(out)))
`

test('exec: non-root, read-only root, writable /work, no network, no host secrets', { skip }, async () => {
  const dir = await project({ 'probe.js': PROBE })
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak'
  const result = await createSandbox({ cli }).exec(dir, ['node', 'probe.js'], { timeoutMs: 60_000 })
  assert.equal(result.ok, true, result.output)
  const out = JSON.parse(result.output.split('\n').at(-1)!)
  assert.equal(out.uid, 1000)
  assert.equal(out.rootWritable, false)
  assert.equal(out.workWritable, true)
  assert.equal(out.network, false)
  assert.ok(!out.env.includes('ANTHROPIC_API_KEY'))
})

test('exec: a timeout removes the container', { skip }, async () => {
  const dir = await project({})
  const result = await createSandbox({ cli }).exec(dir, ['sleep', '60'], { timeoutMs: 3000 })
  assert.equal(result.timedOut, true)
  const left = execFileSync('docker', ['ps', '-aq', '--filter', 'label=dig.sandbox=1', '--filter', 'name=dig-exec-']).toString().trim()
  assert.equal(left, '')
})

test('preview: starts on an internal network, becomes ready, has no internet, is reaped', { skip, timeout: 90_000 }, async () => {
  const server = `
require('http').createServer(async (req, res) => {
  let internet = false
  try { await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(2000) }); internet = true } catch {}
  res.end(JSON.stringify({ path: req.url, host: req.headers.host, internet, gateway: process.env.DIG_GATEWAY_URL }))
}).listen(5173, '0.0.0.0')`
  const dir = await project({ 'server.js': server })
  let now = 0
  const network = 'dig-preview-it'
  const manager = createPreviewManager({ cli, network, idleMs: 1000, now: () => now })
  const preview = { id: 'it-test', workdir: dir, command: ['node', 'server.js'], env: { DIG_GATEWAY_URL: 'http://odoo-gateway:8070' } }
  try {
    let state = await manager.ensure(preview)
    for (let i = 0; i < 40 && state.state !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 250))
      state = await manager.ensure(preview)
    }
    assert.equal(state.state, 'ready')
    const body = await (await fetch(`${state.target}/hello`)).json()
    assert.deepEqual(body, { path: '/hello', host: state.target.replace('http://', ''), internet: false, gateway: 'http://odoo-gateway:8070' })
    const inspect = execFileSync('docker', ['network', 'inspect', '-f', '{{.Internal}}', network]).toString().trim()
    assert.equal(inspect, 'true')

    now = 5000
    assert.deepEqual(await manager.reap(), ['it-test'])
    const running = execFileSync('docker', ['ps', '-q', '--filter', `name=${containerName('it-test')}`]).toString().trim()
    assert.equal(running, '')
  } finally {
    await manager.stop('it-test')
    await cli.run(['network', 'rm', network])
  }
})
