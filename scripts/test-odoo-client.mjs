// Run: node --experimental-strip-types scripts/test-odoo-client.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOdooClient, OdooError } from '../src/lib/odoo-client.ts'

const base = {
  baseUrl: 'https://odoo.example.com',
  apiKey: 'sekrit-key-123',
  allowedModels: ['planning.slot', 'svs.tech.visit'],
}

function mockFetch(status, payload, calls = []) {
  return async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(payload), { status })
  }
}

test('sends JSON-2 request with bearer key, company filter and context', async () => {
  const calls = []
  const client = createOdooClient({ ...base, database: 'prod', fetch: mockFetch(200, [{ id: 1 }], calls) })
  const rows = await client.searchRead({ model: 'planning.slot', fields: ['id', 'name'], companyId: 2 })
  assert.deepEqual(rows, [{ id: 1 }])
  const { url, init } = calls[0]
  assert.equal(url, 'https://odoo.example.com/json/2/planning.slot/search_read')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'bearer sekrit-key-123')
  assert.equal(init.headers['X-Odoo-Database'], 'prod')
  const body = JSON.parse(init.body)
  assert.deepEqual(body.domain, [['company_id', '=', 2]])
  assert.deepEqual(body.context, { allowed_company_ids: [2] })
  assert.equal(body.limit, 500)
})

test('extra domain is appended after the company filter', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [], calls) })
  await client.searchRead({ model: 'svs.tech.visit', fields: ['id'], companyId: 2, domain: [['state', '=', 'done']] })
  assert.deepEqual(JSON.parse(calls[0].init.body).domain, [['company_id', '=', 2], ['state', '=', 'done']])
})

test('refuses models outside the allowlist without calling fetch', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [], calls) })
  await assert.rejects(client.searchRead({ model: 'res.users', fields: ['id'], companyId: 2 }), OdooError)
  await assert.rejects(client.searchRead({ model: 'planning.slot/../../x', fields: ['id'], companyId: 2 }), OdooError)
  assert.equal(calls.length, 0)
})

test('requires companyId and valid field names', async () => {
  const client = createOdooClient({ ...base, fetch: mockFetch(200, []) })
  await assert.rejects(client.searchRead({ model: 'planning.slot', fields: ['id'], companyId: 0 }), OdooError)
  await assert.rejects(client.searchRead({ model: 'planning.slot', fields: [], companyId: 2 }), OdooError)
  await assert.rejects(client.searchRead({ model: 'planning.slot', fields: ['id; drop'], companyId: 2 }), OdooError)
})

test('clamps limit', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [], calls) })
  await client.searchRead({ model: 'planning.slot', fields: ['id'], companyId: 2, limit: 99999 })
  assert.equal(JSON.parse(calls[0].init.body).limit, 1000)
})

test('upstream error: status kept, key never leaked', async () => {
  const client = createOdooClient({
    ...base,
    fetch: mockFetch(403, { name: 'odoo.exceptions.AccessError', message: 'Access denied', debug: 'secret traceback' }),
  })
  await assert.rejects(client.searchRead({ model: 'planning.slot', fields: ['id'], companyId: 2 }), (e) => {
    assert.ok(e instanceof OdooError)
    assert.equal(e.status, 403)
    assert.equal(e.odooName, 'odoo.exceptions.AccessError')
    assert.ok(!e.message.includes('sekrit-key-123'))
    assert.ok(!e.message.includes('traceback'))
    return true
  })
})

test('network failure and non-array response become OdooError', async () => {
  const failing = createOdooClient({ ...base, fetch: async () => { throw new Error('boom sekrit-key-123') } })
  await assert.rejects(failing.searchRead({ model: 'planning.slot', fields: ['id'], companyId: 2 }), (e) => {
    assert.ok(e instanceof OdooError)
    assert.ok(!e.message.includes('sekrit-key-123'))
    return true
  })
  const odd = createOdooClient({ ...base, fetch: mockFetch(200, { result: [] }) })
  await assert.rejects(odd.searchRead({ model: 'planning.slot', fields: ['id'], companyId: 2 }), OdooError)
})

test('timeout aborts the request', async () => {
  const client = createOdooClient({
    ...base,
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))),
  })
  await assert.rejects(client.searchRead({ model: 'planning.slot', fields: ['id'], companyId: 2 }), /timed out/)
})

test('config validation: https required, key required', () => {
  assert.throws(() => createOdooClient({ ...base, baseUrl: 'http://odoo.example.com' }), OdooError)
  assert.throws(() => createOdooClient({ ...base, apiKey: '' }), OdooError)
  assert.doesNotThrow(() => createOdooClient({ ...base, baseUrl: 'http://localhost:8069' }))
})
