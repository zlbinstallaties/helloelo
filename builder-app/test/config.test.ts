import test from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, parseProjects, publicProject } from '../src/config.ts'
import { makeRepo } from './helpers.ts'

async function entry(extra: Record<string, unknown> = {}) {
  return { id: 'dashboard', workdir: await makeRepo(), baseBranch: 'main', ...extra }
}

test('a minimal project gets safe defaults', async () => {
  const [project] = parseProjects({ projects: [await entry()] }, {})
  assert.equal(project.name, 'dashboard')
  assert.equal(project.sandbox, true)
  assert.equal(project.publish, undefined)
  assert.deepEqual(publicProject(project).publish, null)
})

test('bad projects are refused with a message that names the project', async () => {
  const good = await entry()
  const cases: Array<[unknown, RegExp]> = [
    [{}, /at least one project/],
    [{ projects: [] }, /at least one project/],
    [{ projects: [{ ...good, id: 'Bad Id' }] }, /invalid project id/],
    [{ projects: [{ ...good, id: 'dashboard-live' }] }, /invalid project id/],
    [{ projects: [good, good] }, /duplicate/],
    [{ projects: [{ ...good, workdir: 'relative/path' }] }, /absolute/],
    [{ projects: [{ ...good, workdir: '/does/not/exist' }] }, /does not exist/],
    [{ projects: [{ ...good, baseBranch: 'builder/x' }] }, /baseBranch/],
    [{ projects: [{ ...good, previewUrl: 'ftp://x' }] }, /previewUrl/],
    [{ projects: [{ ...good, gatewayUrl: 'http://g', gatewayTokenEnv: 'NOT_SET' }] }, /NOT_SET is not set/],
  ]
  for (const [raw, message] of cases) assert.throws(() => parseProjects(raw, {}), (e: Error) => e instanceof ConfigError && message.test(e.message), JSON.stringify(raw).slice(0, 80))
})

test('publish settings: defaults, the live gateway token from the environment, and nothing secret in the public view', async () => {
  const [bare] = parseProjects({ projects: [await entry({ publish: {} })] }, {})
  assert.deepEqual(bare.publish?.config, { build: ['bun', 'run', 'build'], start: ['bun', 'run', 'start'], port: 3000, healthPath: '/', env: {} })

  const [full] = parseProjects({
    projects: [await entry({
      gatewayUrl: 'http://odoo-gateway:8070', gatewayTokenEnv: 'AGENT_TOKEN',
      publish: { start: ['node', 'scripts/serve.mjs'], port: 4000, healthPath: '/api/health', gatewayUrl: 'http://odoo-gateway:8070', gatewayTokenEnv: 'LIVE_TOKEN', env: { TZ: 'Europe/Amsterdam' }, url: 'https://dashboard-live.example.nl' },
    })],
  }, { AGENT_TOKEN: 'agent-secret', LIVE_TOKEN: 'live-secret' })
  const config = full.publish!.config
  assert.deepEqual(config.start, ['node', 'scripts/serve.mjs'])
  assert.equal(config.port, 4000)
  assert.deepEqual(config.env, { TZ: 'Europe/Amsterdam', DIG_GATEWAY_URL: 'http://odoo-gateway:8070', DIG_GATEWAY_TOKEN: 'live-secret' })
  assert.notEqual(config.env.DIG_GATEWAY_TOKEN, 'agent-secret', 'the live app never gets the agent token')

  const visible = JSON.stringify(publicProject(full))
  assert.deepEqual(publicProject(full).publish, { url: 'https://dashboard-live.example.nl' })
  assert.ok(!visible.includes('secret') && !visible.includes('DIG_GATEWAY'))
})

test('invalid publish settings fail at start-up, not at the first publish', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ build: [] }, /publish\.build/],
    [{ build: 'bun run build' }, /publish\.build/],
    [{ start: ['ok', 3] }, /publish\.start/],
    [{ port: 0 }, /publish\.port/],
    [{ port: '3000' }, /publish\.port/],
    [{ healthPath: 'health' }, /healthPath/],
    [{ healthPath: '/a b' }, /healthPath/],
    [{ env: { 'lower': 'x' } }, /publish\.env/],
    [{ env: { ODOO_API_KEY: 'x' } }, /secret env/],
    [{ env: { ANTHROPIC_API_KEY: 'x' } }, /secret env/],
    [{ gatewayUrl: 'http://g' }, /both be set/],
    [{ url: 'javascript:alert(1)' }, /publish\.url/],
  ]
  for (const [publish, message] of cases) {
    assert.throws(() => parseProjects({ projects: [{ id: 'a', workdir: '/tmp', baseBranch: 'main', publish }] }, {}), () => true, 'workdir is checked first')
    const withRepo = { projects: [await entry({ publish })] }
    assert.throws(() => parseProjects(withRepo, {}), (e: Error) => e instanceof ConfigError && message.test(e.message), JSON.stringify(publish))
  }
})
