import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CustomerFactsNotInstalledError, OdooError, OdooWriteError, type OdooClient } from '../../src/lib/odoo-client.ts'
import { CUSTOMER_FACT_FIELDS } from '../../src/lib/documents/customer-facts.ts'
import { parseProjects, sha256Hex } from '../src/projects.ts'
import { createGateway, type AccessLogEntry } from '../src/server.ts'

const FACTS = 'facts-token-123'
const OTHER = 'other-token-456'
const REQUEST = 'facts-0123456789abcdef'
const NOW = Date.UTC(2026, 9, 12, 10, 0)

const projects = parseProjects({
  projects: [
    { id: 'dashboard-facts', tokenSha256: sha256Hex(FACTS), companyId: 2, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } }, actions: { setCustomerFacts: { maxPerHour: 2 } } },
    { id: 'preview', tokenSha256: sha256Hex(OTHER), companyId: 2, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } } },
  ],
})

const body = (overrides: Record<string, unknown> = {}) => ({
  requestId: REQUEST,
  reference: { model: 'planning.slot', id: 12 },
  facts: { isolatie: 'matig', aantal_personen: 3, leidinglengte_m: 12.5, asbest_vermoed: 'nee' },
  ...overrides,
})

type Call = { method: string; params: any }
const emptyCustomer = () => Object.fromEntries(CUSTOMER_FACT_FIELDS.map((field) => [field, false]))

function fakeOdoo(overrides: Partial<OdooClient> = {}, current: () => Record<string, unknown> | null = emptyCustomer) {
  const calls: Call[] = []
  const unexpected = (name: string) => async () => { throw new Error(`unexpected call: ${name}`) }
  const odoo: OdooClient = {
    searchRead: unexpected('searchRead'), searchCount: unexpected('searchCount'), fieldsGet: unexpected('fieldsGet'), createEmployee: unexpected('createEmployee'),
    setEmployeePlanningRoles: unexpected('setEmployeePlanningRoles'), checkResponsible: unexpected('checkResponsible'), checkPlanningRoles: unexpected('checkPlanningRoles'),
    listPlanningRoles: unexpected('listPlanningRoles'), readEmployee: unexpected('readEmployee'), createUnavailability: unexpected('createUnavailability'),
    readUnavailability: unexpected('readUnavailability'), removeUnavailability: unexpected('removeUnavailability'), postDocument: unexpected('postDocument'),
    async readReferencePartner(params) {
      calls.push({ method: 'readReferencePartner', params })
      return params.id === 12 ? { partnerId: 77, partnerName: 'Familie Van den Berg' } : params.id === 13 ? { partnerId: null, partnerName: null } : null
    },
    async readCustomerFacts() {
      return current()
    },
    async writeCustomerFacts() {},
    ...overrides,
  }
  // Every call is recorded, also when a test replaces the method.
  const read = odoo.readCustomerFacts
  const write = odoo.writeCustomerFacts
  odoo.readCustomerFacts = async (params) => {
    calls.push({ method: 'readCustomerFacts', params })
    return read(params)
  }
  odoo.writeCustomerFacts = async (params) => {
    calls.push({ method: 'writeCustomerFacts', params })
    return write(params)
  }
  return { odoo, calls, names: () => calls.map((call) => call.method), count: (method: string) => calls.filter((call) => call.method === method).length }
}

type Post = (payload: unknown, init?: { token?: string | null; method?: string }) => Promise<{ status: number; json: Record<string, any> }>

async function withGateway(odoo: OdooClient, run: (post: Post) => Promise<void>, options: { logs?: AccessLogEntry[]; now?: () => number } = {}) {
  const server: Server = createServer(createGateway({ projects, odoo, log: (entry) => options.logs?.push(entry), now: options.now ?? (() => NOW) }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await run(async (payload, init = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (init.token !== null) headers.authorization = `Bearer ${init.token ?? FACTS}`
      const method = init.method ?? 'POST'
      const response = await fetch(`${base}/v1/actions/set_customer_facts`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(payload) })
      return { status: response.status, json: (await response.json()) as Record<string, any> }
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('a project without the action cannot set customer facts, and Odoo is not called; no or a wrong token is 401; only POST', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    assert.equal((await post(body(), { token: OTHER })).json.error, 'action_not_allowed')
    assert.equal((await post(body(), { token: null })).status, 401)
    assert.equal((await post(body(), { token: 'nope' })).status, 401)
    assert.equal((await post(body(), { method: 'GET' })).status, 405)
    assert.equal(calls.length, 0)
  })
})

test('the customer is read from the reference record, and only the EMPTY fields are filled, under the Odoo field names', async () => {
  const filled = { ...emptyCustomer(), dig_schouw_isolatie: 'goed', dig_schouw_aantal_personen: 0 }
  const { odoo, calls, names } = fakeOdoo({}, () => filled)
  await withGateway(odoo, async (post) => {
    const answer = await post(body())
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, {
      written: ['aantal_personen', 'leidinglengte_m', 'asbest_vermoed'],
      kept: ['isolatie'],
      customer: 'Familie Van den Berg',
      replayed: false,
    })
    assert.deepEqual(names(), ['readReferencePartner', 'readCustomerFacts', 'writeCustomerFacts'])
    assert.deepEqual(calls[0].params, { model: 'planning.slot', id: 12, companyId: 2 })
    assert.deepEqual(calls[1].params, { partnerId: 77, companyId: 2 })
    assert.deepEqual(calls[2].params, {
      partnerId: 77,
      companyId: 2,
      values: { dig_schouw_aantal_personen: 3, dig_schouw_leidinglengte: 12.5, dig_schouw_asbest_vermoed: 'nee' },
    })
  })
})

test('when every field already has a value nothing is written at all', async () => {
  const filled = Object.fromEntries(CUSTOMER_FACT_FIELDS.map((field) => [field, 'x']))
  const { odoo, count } = fakeOdoo({}, () => filled)
  await withGateway(odoo, async (post) => {
    const answer = await post(body())
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json.written, [])
    assert.equal(answer.json.kept.length, 4)
    assert.equal(count('writeCustomerFacts'), 0)
  })
})

test('only requestId, reference and facts; only facts of the table, each with a valid value; never a customer, a field, a model or any other field of the customer', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ partnerId: 77 }, 'unknown_parameter'],
      [{ companyId: 3 }, 'unknown_parameter'],
      [{ model: 'res.partner' }, 'unknown_parameter'],
      [{ requestId: 'x' }, 'invalid_request_id'],
      [{ reference: { model: 'res.partner', id: 77 } }, 'invalid_reference'],
      [{ reference: { model: 'planning.slot', id: 12, partner_id: 5 } }, 'invalid_reference'],
      [{ reference: { model: 'planning.slot', id: -1 } }, 'invalid_reference'],
      [{ facts: undefined }, 'invalid_facts'],
      [{ facts: {} }, 'invalid_facts'],
      [{ facts: [] }, 'invalid_facts'],
      [{ facts: { name: 'Nieuwe naam' } }, 'invalid_facts'],
      [{ facts: { email: 'x@example.com' } }, 'invalid_facts'],
      [{ facts: { dig_schouw_isolatie: 'goed' } }, 'invalid_facts'],
      [{ facts: { isolatie: 'perfect' } }, 'invalid_facts'],
      [{ facts: { aantal_personen: 99 } }, 'invalid_facts'],
      [{ facts: { aantal_personen: '3' } }, 'invalid_facts'],
      [{ facts: { bouwjaar: 1985.5 } }, 'invalid_facts'],
      [{ facts: { schouw_datum: '2026-02-30' } }, 'invalid_facts'],
      [{ facts: { leidingroute: 'x'.repeat(1001) } }, 'invalid_facts'],
      [{ facts: { isolatie: 'goed', leidinglengte_m: -1 } }, 'invalid_facts'],
    ]
    for (const [overrides, code] of cases) {
      const answer = await post(body(overrides))
      assert.equal(answer.status, 400, JSON.stringify(overrides))
      assert.equal(answer.json.error, code, JSON.stringify(overrides))
    }
    assert.equal(calls.length, 0, 'Odoo is never asked about a request that is wrong')
  })
})

test('a record that is not in the company, or without a customer, stops it before anything is written', async () => {
  const { odoo, names } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    const missing = await post(body({ reference: { model: 'planning.slot', id: 99 } }))
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error, 'reference_not_found')
    const noCustomer = await post(body({ reference: { model: 'svs.tech.visit', id: 13 }, requestId: 'facts-aaaaaaaaaaaaaaaa' }))
    assert.equal(noCustomer.status, 409)
    assert.equal(noCustomer.json.error, 'reference_has_no_customer')
    assert.ok(!names().includes('writeCustomerFacts'))
    assert.ok(!names().includes('readCustomerFacts'), 'the facts of nobody are read')
  })
})

test('when the fields are not in Odoo (the module is not installed) it says so and writes nothing', async () => {
  const { odoo, count } = fakeOdoo({
    async readCustomerFacts() {
      throw new CustomerFactsNotInstalledError(500, 'builtins.ValueError')
    },
  })
  await withGateway(odoo, async (post) => {
    const answer = await post(body())
    assert.equal(answer.status, 409)
    assert.equal(answer.json.error, 'fields_not_installed')
    assert.equal(count('writeCustomerFacts'), 0)
    assert.equal((await post(body())).status, 409, 'and a later try is not blocked')
  })
})

test('the same request id gives the same answer once; other facts with that id are refused; while it runs a repeat is refused', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let first = true
  const { odoo, count } = fakeOdoo({
    async writeCustomerFacts() {
      if (first) { first = false; await gate }
    },
  })
  await withGateway(odoo, async (post) => {
    const running = post(body())
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await post(body())).json.error, 'in_progress')
    release()
    const done = await running
    assert.equal(done.status, 200)
    const again = await post(body())
    assert.equal(again.status, 200)
    assert.equal(again.json.replayed, true)
    assert.deepEqual(again.json.written, done.json.written)
    assert.equal(count('writeCustomerFacts'), 1)
    const other = await post(body({ facts: { isolatie: 'slecht' } }))
    assert.equal(other.status, 409)
    assert.equal(other.json.error, 'request_id_reused')
  })
})

test('a refusal of Odoo says so and may be repeated; no answer is "not known" but a repeat is allowed because it does no harm', async () => {
  let mode: 'rejected' | 'silent' | 'ok' = 'rejected'
  let clock = NOW
  const { odoo, count } = fakeOdoo({
    async writeCustomerFacts() {
      if (mode === 'rejected') throw new OdooWriteError('Odoo res.partner request failed (403): geheim', 403, 'rejected', 'odoo.exceptions.AccessError')
      if (mode === 'silent') throw new OdooWriteError('Odoo res.partner request timed out', 0, 'unknown')
    },
  })
  await withGateway(odoo, async (post) => {
    const refused = await post(body())
    assert.equal(refused.status, 502)
    assert.deepEqual(refused.json, { error: 'odoo_rejected', message: 'odoo.exceptions.AccessError' })
    mode = 'silent'
    clock += 61 * 60_000 // the hour limit counts every try that reached Odoo, so the next ones come an hour later
    const silent = await post(body())
    assert.equal(silent.status, 504)
    assert.equal(silent.json.error, 'outcome_unknown')
    mode = 'ok'
    clock += 61 * 60_000
    const fine = await post(body())
    assert.equal(fine.status, 200)
    assert.equal(fine.json.replayed, false, 'the earlier tries left nothing behind that blocks it')
    assert.equal(count('writeCustomerFacts'), 3)
  }, { now: () => clock })
})

test('Odoo errors while reading the customer are mapped without leaking the upstream message', async () => {
  const { odoo } = fakeOdoo({
    async readCustomerFacts() {
      throw new OdooError('Odoo res.partner request failed (500): Klant Jansen bestaat al', 500, 'odoo.exceptions.UserError')
    },
  })
  await withGateway(odoo, async (post) => {
    const answer = await post(body())
    assert.equal(answer.status, 502)
    assert.deepEqual(answer.json, { error: 'odoo_error', message: 'odoo.exceptions.UserError' })
  })
})

test('at most a few writes per hour per project; an hour later it works again; a call that writes nothing does not count', async () => {
  const filled = Object.fromEntries(CUSTOMER_FACT_FIELDS.map((field) => [field, 'x']))
  let clock = NOW
  let customer: Record<string, unknown> = emptyCustomer()
  const { odoo } = fakeOdoo({}, () => customer)
  await withGateway(odoo, async (post) => {
    assert.equal((await post(body({ requestId: 'facts-000000000000000a' }))).status, 200)
    customer = filled
    for (const id of ['b', 'c', 'd']) assert.equal((await post(body({ requestId: `facts-00000000000000${id}${id}` }))).status, 200, 'nothing to write: no cost')
    customer = emptyCustomer()
    assert.equal((await post(body({ requestId: 'facts-000000000000000e' }))).status, 200)
    const third = await post(body({ requestId: 'facts-000000000000000f' }))
    assert.equal(third.status, 429)
    assert.equal(third.json.error, 'rate_limited')
    clock += 61 * 60_000
    assert.equal((await post(body({ requestId: 'facts-0000000000000010' }))).status, 200)
  }, { now: () => clock })
})

test('the log has the request id and never the facts, the customer or the token', async () => {
  const logs: AccessLogEntry[] = []
  const { odoo } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    await post(body({ facts: { leidingroute: 'Door de achtergevel naast de keuken', isolatie: 'matig' } }))
  }, { logs })
  const text = JSON.stringify(logs)
  assert.ok(text.includes(REQUEST))
  for (const secret of ['achtergevel', 'matig', 'Van den Berg', FACTS]) assert.ok(!text.includes(secret), `${secret} is not logged`)
})

test('the action is no other action: a project with it cannot post documents or create employees', async () => {
  const { odoo, calls } = fakeOdoo()
  const server: Server = createServer(createGateway({ projects, odoo, log: () => {}, now: () => NOW }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    for (const route of ['post_document', 'create_employee', 'set_employee_planning_roles', 'add_employee_unavailability']) {
      const response = await fetch(`${base}/v1/actions/${route}`, { method: 'POST', headers: { authorization: `Bearer ${FACTS}`, 'content-type': 'application/json' }, body: '{}' })
      assert.equal(response.status, 403, route)
    }
    assert.equal(calls.length, 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
