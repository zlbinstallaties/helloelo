import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OdooError, type OdooClient } from '../../src/lib/odoo-client.ts'
import { parseProjects, sha256Hex } from '../src/projects.ts'
import { createGateway, type AccessLogEntry } from '../src/server.ts'

const TOKEN = 'project-token-123'
const OTHER = 'other-token-456'

const projects = parseProjects({
  projects: [
    {
      id: 'dashboard',
      tokenSha256: sha256Hex(TOKEN),
      companyId: 2,
      maxLimit: 100,
      models: {
        'planning.slot': { fields: ['name', 'state'], methods: ['search_read', 'search_count'] },
        'svs.tech.visit': { fields: ['name'], methods: ['search_count'] },
      },
    },
    {
      id: 'other',
      tokenSha256: sha256Hex(OTHER),
      companyId: 3,
      models: { 'svs.tech.visit': { fields: ['name'], methods: ['search_read'] } },
    },
  ],
})

interface Call {
  method: string
  params: unknown
}

function fakeOdoo(calls: Call[], overrides: Partial<OdooClient> = {}): OdooClient {
  return {
    async searchRead(params) {
      calls.push({ method: 'search_read', params })
      return [{ id: 1, name: 'Slot 1' }] as never[]
    },
    async searchCount(params) {
      calls.push({ method: 'search_count', params })
      return 4
    },
    async fieldsGet(model) {
      calls.push({ method: 'fields_get', params: model })
      return {
        id: { type: 'integer', string: 'ID' },
        name: { type: 'char', string: 'Naam', required: true },
        password_hash: { type: 'char' },
      }
    },
    async createEmployee() {
      throw new Error('createEmployee is not used in these tests')
    },
    async createUnavailability() {
      throw new Error('createUnavailability is not used in these tests')
    },
    async readUnavailability() {
      throw new Error('readUnavailability is not used in these tests')
    },
    async removeUnavailability() {
      throw new Error('removeUnavailability is not used in these tests')
    },
    async readReferencePartner() {
      throw new Error('readReferencePartner is not used in these tests')
    },
    async postDocument() {
      throw new Error('postDocument is not used in these tests')
    },
    async checkResponsible() {
      throw new Error('checkResponsible is not used in these tests')
    },
    async checkPlanningRoles() {
      throw new Error('checkPlanningRoles is not used in these tests')
    },
    async listPlanningRoles() {
      throw new Error('listPlanningRoles is not used in these tests')
    },
    async setEmployeePlanningRoles() {
      throw new Error('setEmployeePlanningRoles is not used in these tests')
    },
    async readEmployee() {
      throw new Error('readEmployee is not used in these tests')
    },
    ...overrides,
  }
}

async function start(odoo: OdooClient, logs: AccessLogEntry[] = []) {
  const server: Server = createServer(createGateway({ projects, odoo, log: (e) => logs.push(e) }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    async request(path: string, init: { method?: string; token?: string | null; body?: unknown } = {}) {
      const headers: Record<string, string> = {}
      if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`
      if (init.body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(base + path, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      return { status: response.status, json: (await response.json()) as Record<string, any> }
    },
  }
}

test('healthz needs no token', async () => {
  const gw = await start(fakeOdoo([]))
  try {
    assert.deepEqual((await gw.request('/healthz', { token: null })).json, { status: 'ok' })
  } finally {
    await gw.close()
  }
})

test('missing or wrong token is 401 and Odoo is not called', async () => {
  const calls: Call[] = []
  const gw = await start(fakeOdoo(calls))
  try {
    assert.equal((await gw.request('/v1/schema', { token: null })).status, 401)
    assert.equal((await gw.request('/v1/schema', { token: 'nope' })).status, 401)
    const r = await gw.request('/v1/models/planning.slot/search_read', { token: 'nope', body: {} })
    assert.equal(r.status, 401)
    assert.equal(calls.length, 0)
  } finally {
    await gw.close()
  }
})

test('search_read forces company and maxLimit from the project', async () => {
  const calls: Call[] = []
  const logs: AccessLogEntry[] = []
  const gw = await start(fakeOdoo(calls), logs)
  try {
    const r = await gw.request('/v1/models/planning.slot/search_read', {
      body: { domain: [['state', '=', 'planned']], order: 'name desc' },
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.records, [{ id: 1, name: 'Slot 1' }])
    assert.deepEqual(calls[0].params, {
      model: 'planning.slot',
      fields: ['id', 'name', 'state'],
      companyId: 2,
      domain: [['state', '=', 'planned']],
      limit: 100,
      offset: 0,
      order: 'name desc',
    })
    assert.equal(logs[0].project, 'dashboard')
    assert.equal(logs[0].rows, 1)
    assert.deepEqual(logs[0].domainFields, ['state'])
    assert.ok(!JSON.stringify(logs).includes('planned'), 'domain values are not logged')
    assert.ok(!JSON.stringify(logs).includes(TOKEN), 'token is not logged')
  } finally {
    await gw.close()
  }
})

test('the request cannot widen company, model, method, fields or limit', async () => {
  const calls: Call[] = []
  const gw = await start(fakeOdoo(calls))
  try {
    const cases: Array<[string, unknown, number, string]> = [
      ['/v1/models/res.users/search_read', {}, 403, 'model_not_allowed'],
      ['/v1/models/svs.tech.visit/search_read', {}, 403, 'method_not_allowed'],
      ['/v1/models/planning.slot/write', {}, 404, 'not_found'],
      ['/v1/models/planning.slot/search_read', { fields: ['partner_id'] }, 403, 'field_not_allowed'],
      ['/v1/models/planning.slot/search_read', { domain: [['company_id', '=', 3]] }, 403, 'field_not_allowed'],
      ['/v1/models/planning.slot/search_read', { domain: ['|', ['state', '=', 'x']] }, 400, 'invalid_domain'],
      ['/v1/models/planning.slot/search_read', { limit: 101 }, 400, 'invalid_limit'],
      ['/v1/models/planning.slot/search_read', { companyId: 3 }, 400, 'unknown_parameter'],
      ['/v1/models/planning.slot/search_read', { context: { allowed_company_ids: [3] } }, 400, 'unknown_parameter'],
    ]
    for (const [path, body, status, code] of cases) {
      const r = await gw.request(path, { body })
      assert.equal(r.status, status, `${path} ${JSON.stringify(body)}`)
      assert.equal(r.json.error, code, `${path} ${JSON.stringify(body)}`)
    }
    assert.equal(calls.length, 0)
  } finally {
    await gw.close()
  }
})

test('a project only sees its own models', async () => {
  const gw = await start(fakeOdoo([]))
  try {
    const r = await gw.request('/v1/models/planning.slot/search_read', { token: OTHER, body: {} })
    assert.equal(r.status, 403)
    assert.equal(r.json.error, 'model_not_allowed')
  } finally {
    await gw.close()
  }
})

test('search_count returns the count', async () => {
  const calls: Call[] = []
  const gw = await start(fakeOdoo(calls))
  try {
    const r = await gw.request('/v1/models/svs.tech.visit/search_count', { body: { domain: [['name', 'ilike', 'TV']] } })
    assert.deepEqual(r.json, { count: 4 })
    assert.deepEqual(calls[0].params, { model: 'svs.tech.visit', companyId: 2, domain: [['name', 'ilike', 'TV']] })
  } finally {
    await gw.close()
  }
})

test('schema only lists allowlisted fields and reports missing ones', async () => {
  const calls: Call[] = []
  const gw = await start(fakeOdoo(calls))
  try {
    const r = await gw.request('/v1/schema')
    assert.equal(r.status, 200)
    assert.equal(r.json.companyId, 2)
    const slot = r.json.models.find((m: { name: string }) => m.name === 'planning.slot')
    assert.deepEqual(slot.fields.map((f: { name: string }) => f.name), ['id', 'name'])
    assert.deepEqual(slot.missing, ['state'])
    assert.ok(!JSON.stringify(r.json).includes('password_hash'))
    await gw.request('/v1/schema')
    assert.equal(calls.filter((c) => c.method === 'fields_get').length, 2, 'fields_get is cached per model')
  } finally {
    await gw.close()
  }
})

test('schema: a model this Odoo does not have is reported, and the other models are still answered', async () => {
  const gw = await start(
    fakeOdoo([], {
      async fieldsGet(model) {
        if (model === 'svs.tech.visit') throw new OdooError("Odoo svs.tech.visit read failed (404): the model 'svs.tech.visit' does not exist", 404, 'werkzeug.exceptions.NotFound', true)
        return { id: { type: 'integer', string: 'ID' }, name: { type: 'char', string: 'Naam' }, state: { type: 'char', string: 'Status' } }
      },
    }),
  )
  try {
    const r = await gw.request('/v1/schema')
    assert.equal(r.status, 200)
    const byName = Object.fromEntries(r.json.models.map((m: { name: string }) => [m.name, m]))
    assert.deepEqual(byName['planning.slot'].fields.map((f: { name: string }) => f.name), ['id', 'name', 'state'])
    assert.equal(byName['planning.slot'].unknownModel, undefined)
    assert.equal(byName['svs.tech.visit'].unknownModel, true)
    assert.deepEqual(byName['svs.tech.visit'].fields, [])
    assert.deepEqual(byName['svs.tech.visit'].missing, ['id', 'name'])
  } finally {
    await gw.close()
  }
})

test('schema: other errors are not hidden as an unknown model', async () => {
  for (const [error, status] of [
    [new OdooError('Odoo svs.tech.visit read failed (404): the model needs another route', 404, 'werkzeug.exceptions.NotFound', true), 502],
    [new OdooError('Odoo svs.tech.visit read failed (404)', 404), 502],
    [new OdooError("Odoo svs.tech.visit read failed (404): the model 'svs.tech.visit' does not exist", 404), 502], // no Odoo error body: not proof
    [new OdooError('Odoo svs.tech.visit read failed (403): the model does not exist for you', 403, 'odoo.exceptions.AccessError', true), 502],
    [new OdooError('Odoo svs.tech.visit read timed out', 0), 504],
  ] as const) {
    const gw = await start(fakeOdoo([], { async fieldsGet() { throw error } }))
    try {
      const r = await gw.request('/v1/schema')
      assert.equal(r.status, status, error.message)
    } finally {
      await gw.close()
    }
  }
})

test('Odoo errors are mapped without leaking the upstream message', async () => {
  const gw = await start(
    fakeOdoo([], {
      async searchRead() {
        throw new OdooError('Odoo planning.slot read failed (500): Klant Jansen bestaat al', 500, 'odoo.exceptions.UserError')
      },
      async searchCount() {
        throw new OdooError('Odoo planning.slot read timed out', 0)
      },
    }),
  )
  try {
    const r = await gw.request('/v1/models/planning.slot/search_read', { body: {} })
    assert.equal(r.status, 502)
    assert.deepEqual(r.json, { error: 'odoo_error', message: 'odoo.exceptions.UserError' })
    const t = await gw.request('/v1/models/planning.slot/search_count', { body: {} })
    assert.equal(t.status, 504)
  } finally {
    await gw.close()
  }
})

test('bad bodies are rejected', async () => {
  const gw = await start(fakeOdoo([]))
  try {
    const base = gw
    assert.equal((await base.request('/v1/models/planning.slot/search_read', { method: 'GET' })).status, 405)
    const big = await base.request('/v1/models/planning.slot/search_read', { body: { order: 'x'.repeat(70_000) } })
    assert.equal(big.status, 413)
    const arr = await base.request('/v1/models/planning.slot/search_read', { body: [1] })
    assert.equal(arr.json.error, 'invalid_json')
  } finally {
    await gw.close()
  }
})
