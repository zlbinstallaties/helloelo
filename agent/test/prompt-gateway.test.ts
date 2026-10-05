import test from 'node:test'
import assert from 'node:assert/strict'
import { createSchemaReader } from '../src/gateway.ts'
import { buildSystemPrompt } from '../src/prompt.ts'
import { Workspace } from '../src/workspace.ts'
import { tempProject } from './helpers.ts'

test('project rules are appended as data', async () => {
  const plain = await buildSystemPrompt(await Workspace.open(await tempProject()))
  assert.doesNotMatch(plain, /project_rules/)
  const ws = await Workspace.open(await tempProject({ 'RULES.md': 'Gebruik huisstijlkleur #e30613.' }))
  const withRules = await buildSystemPrompt(ws)
  assert.match(withRules, /<project_rules>\nGebruik huisstijlkleur #e30613.\n<\/project_rules>/)
})

test('schema reader sends the token, caches, and hides upstream details', async () => {
  const calls: Array<{ url: string; auth: string | null }> = []
  const okFetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization') })
    return new Response(JSON.stringify({ models: [] }), { status: 200 })
  }) as typeof fetch
  const read = createSchemaReader('http://odoo-gateway:8070', 'tok', okFetch)
  assert.deepEqual(await read(), { models: [] })
  await read()
  assert.deepEqual(calls, [{ url: 'http://odoo-gateway:8070/v1/schema', auth: 'Bearer tok' }])

  const denied = createSchemaReader('http://g', 'bad', (async () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as unknown as typeof fetch)
  await assert.rejects(denied(), /401: unauthorized/)
  const down = createSchemaReader('http://g', 't', (async () => {
    throw new Error('ECONNREFUSED 10.0.0.1')
  }) as unknown as typeof fetch)
  await assert.rejects(down(), /niet bereikbaar$/)
})
