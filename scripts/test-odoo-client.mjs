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

test('searchCount sends company filter and returns the integer', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, 7, calls) })
  assert.equal(await client.searchCount({ model: 'planning.slot', companyId: 2, domain: [['state', '=', 'x']] }), 7)
  assert.equal(calls[0].url, 'https://odoo.example.com/json/2/planning.slot/search_count')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.domain, [['company_id', '=', 2], ['state', '=', 'x']])
  assert.deepEqual(body.context, { allowed_company_ids: [2] })
  const odd = createOdooClient({ ...base, fetch: mockFetch(200, [1]) })
  await assert.rejects(odd.searchCount({ model: 'planning.slot', companyId: 2 }), OdooError)
})

test('fieldsGet asks for attributes only and respects the allowlist', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, { name: { type: 'char' } }, calls) })
  assert.deepEqual(await client.fieldsGet('svs.tech.visit'), { name: { type: 'char' } })
  assert.equal(calls[0].url, 'https://odoo.example.com/json/2/svs.tech.visit/fields_get')
  assert.deepEqual(JSON.parse(calls[0].init.body), { attributes: ['type', 'string', 'relation', 'required', 'readonly'] })
  await assert.rejects(client.fieldsGet('res.users'), OdooError)
  assert.equal(calls.length, 1)
})

// ---- The one write the client has: a technician as hr.employee, without an Odoo login ----

import { OdooWriteError } from '../src/lib/odoo-client.ts'

const employee = { name: 'Jan de Vries', companyId: 2, responsibleUserId: 9, dateVersion: '2026-10-06' }

test('createEmployee sends one fixed hr.employee create and returns the id Odoo confirms', async () => {
  const calls = []
  const client = createOdooClient({ ...base, database: 'test', fetch: mockFetch(200, [41], calls) })
  assert.equal(await client.createEmployee(employee), 41)
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://odoo.example.com/json/2/hr.employee/create')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'bearer sekrit-key-123')
  assert.equal(init.headers['X-Odoo-Database'], 'test')
  const body = JSON.parse(init.body)
  assert.deepEqual(Object.keys(body).sort(), ['context', 'vals_list'])
  assert.deepEqual(body.vals_list, [
    { name: 'Jan de Vries', company_id: 2, hr_responsible_id: 9, user_id: false, date_version: '2026-10-06' },
  ])
  assert.equal(body.context.allowed_company_ids.length, 1)
  assert.equal(body.context.allowed_company_ids[0], 2)
})

test('createEmployee never sets a user: user_id is false, whatever the caller tries', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [41], calls) })
  await client.createEmployee({ ...employee, userId: 5, user_id: 5, vals: { user_id: 5, groups_id: [1] }, model: 'res.users' })
  const [vals] = JSON.parse(calls[0].init.body).vals_list
  assert.equal(vals.user_id, false)
  assert.deepEqual(Object.keys(vals).sort(), ['company_id', 'date_version', 'hr_responsible_id', 'name', 'user_id'])
  assert.equal(calls[0].url, 'https://odoo.example.com/json/2/hr.employee/create')
})

test('createEmployee accepts a bare id as well, and nothing else as a confirmation', async () => {
  assert.equal(await createOdooClient({ ...base, fetch: mockFetch(200, 41) }).createEmployee(employee), 41)
  for (const payload of [[], {}, null, [0], [-1], [1.5], ['41'], [41, 42], 0, 'ok', { id: 41 }]) {
    const client = createOdooClient({ ...base, fetch: mockFetch(200, payload) })
    await assert.rejects(client.createEmployee(employee), (e) => e instanceof OdooWriteError && e.outcome === 'unknown', JSON.stringify(payload))
  }
})

test('createEmployee refuses odd input before it calls Odoo', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [41], calls) })
  const bad = [
    { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 'Jan\nde Vries' }, { name: 'Jan\u0000' }, { name: 5 },
    { companyId: 0 }, { companyId: 1.5 }, { companyId: '2' },
    { responsibleUserId: 0 }, { responsibleUserId: -1 }, { responsibleUserId: undefined }, { responsibleUserId: '9' },
    { dateVersion: '06-10-2026' }, { dateVersion: '2026-13-40' }, { dateVersion: '2026-02-30' }, { dateVersion: undefined },
  ]
  for (const change of bad) {
    await assert.rejects(client.createEmployee({ ...employee, ...change }), (e) => e instanceof OdooWriteError && e.outcome === 'rejected', JSON.stringify(change))
  }
  assert.equal(calls.length, 0)
})

test('createEmployee: an answer from Odoo with an error is a definite refusal; a missing answer is an unknown outcome', async () => {
  const refusals = [
    [403, { name: 'odoo.exceptions.AccessError', message: 'Access denied' }],
    [422, { name: 'odoo.exceptions.ValidationError', message: 'Invalid' }],
    [400, { name: 'builtins.TypeError', message: 'bad' }],
    [500, { name: 'odoo.exceptions.UserError', message: 'No' }],
  ]
  for (const [status, payload] of refusals) {
    const client = createOdooClient({ ...base, fetch: mockFetch(status, payload) })
    await assert.rejects(client.createEmployee(employee), (e) => e instanceof OdooWriteError && e.outcome === 'rejected' && e.status === status, String(status))
  }
  const unknown = [
    createOdooClient({ ...base, fetch: async () => { throw new Error('boom sekrit-key-123') } }),
    createOdooClient({ ...base, fetch: mockFetch(504, { message: 'gateway timeout' }) }),
    createOdooClient({ ...base, fetch: mockFetch(502, null) }),
    createOdooClient({ ...base, fetch: mockFetch(503, { name: 'x' }) }),
    createOdooClient({
      ...base,
      timeoutMs: 10,
      fetch: (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))),
    }),
  ]
  for (const client of unknown) {
    await assert.rejects(client.createEmployee(employee), (e) => {
      assert.ok(e instanceof OdooWriteError)
      assert.equal(e.outcome, 'unknown')
      assert.ok(!e.message.includes('sekrit-key-123'))
      return true
    })
  }
})

test('createEmployee does not leak the key or the debug text of Odoo', async () => {
  const client = createOdooClient({ ...base, fetch: mockFetch(403, { name: 'odoo.exceptions.AccessError', message: 'no', debug: 'secret traceback' }) })
  await assert.rejects(client.createEmployee(employee), (e) => {
    assert.ok(!e.message.includes('sekrit-key-123'))
    assert.ok(!e.message.includes('traceback'))
    return true
  })
})

test('the generic reads still refuse hr.employee and res.users', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [], calls) })
  for (const model of ['hr.employee', 'res.users']) {
    await assert.rejects(client.searchRead({ model, fields: ['id'], companyId: 2 }), OdooError)
    await assert.rejects(client.searchCount({ model, companyId: 2 }), OdooError)
    await assert.rejects(client.fieldsGet(model), OdooError)
  }
  assert.equal(calls.length, 0)
})

test('responsible check: a user qualifies only when they exist, are active, are internal and belong to the company', async () => {
  const run = async (rows, calls = []) => createOdooClient({ ...base, fetch: mockFetch(200, rows, calls) }).checkResponsible({ userId: 9, companyId: 2 })
  assert.deepEqual(await run([{ id: 9, active: true, share: false, company_ids: [1, 2] }]), { exists: true, active: true, internal: true, inCompany: true })
  assert.deepEqual(await run([]), { exists: false, active: false, internal: false, inCompany: false })
  assert.deepEqual(await run([{ id: 9, active: false, share: false, company_ids: [2] }]), { exists: true, active: false, internal: true, inCompany: true })
  assert.deepEqual(await run([{ id: 9, active: true, share: true, company_ids: [2] }]), { exists: true, active: true, internal: false, inCompany: true })
  assert.deepEqual(await run([{ id: 9, active: true, share: false, company_ids: [3] }]), { exists: true, active: true, internal: true, inCompany: false })
  assert.deepEqual(await run([{ id: 8, active: true, share: false, company_ids: [2] }]), { exists: false, active: false, internal: false, inCompany: false }, 'a different record is no match')
})

test('employee read-back fails closed: only an explicit empty user_id means "no Odoo user"', async () => {
  const read = async (patch) => {
    const rows = [{ id: 41, name: 'Jan de Vries', company_id: [2, 'DIG'], user_id: false, active: true, ...patch }]
    return createOdooClient({ ...base, fetch: mockFetch(200, rows) }).readEmployee({ id: 41, companyId: 2 })
  }
  for (const user_id of [false, null]) assert.equal((await read({ user_id })).userLinked, false, JSON.stringify(user_id))
  // Odoo 20 sends [id, name]; a bare id and an {id} object are read too; anything else is still "linked".
  for (const user_id of [[5, 'Jan'], 5, { id: 5 }]) {
    const record = await read({ user_id })
    assert.equal(record.userLinked, true, JSON.stringify(user_id))
    assert.equal(record.userId, 5, JSON.stringify(user_id))
  }
  for (const user_id of [true, 'Jan', [], ['x', 'Jan'], {}, 0, 'false']) {
    const record = await read({ user_id })
    assert.equal(record.userLinked, true, `unreadable ${JSON.stringify(user_id)} must count as linked`)
    assert.equal(record.userId, null, JSON.stringify(user_id))
  }
  const missing = await createOdooClient({ ...base, fetch: mockFetch(200, [{ id: 41, name: 'Jan', company_id: [2, 'DIG'], active: true }]) }).readEmployee({ id: 41, companyId: 2 })
  assert.equal(missing.userLinked, true, 'a missing user_id is not proof of "no user"')
  for (const company_id of [[3, 'Other'], { id: 3 }, 3]) assert.equal((await read({ company_id })).companyId, 3, JSON.stringify(company_id))
  for (const company_id of [false, 'DIG', []]) assert.equal((await read({ company_id })).companyId, null, JSON.stringify(company_id))
})

test('responsible check reads many2many company_ids as ids or as [id, name] pairs, and nothing else', async () => {
  const run = async (company_ids) => createOdooClient({ ...base, fetch: mockFetch(200, [{ id: 9, active: true, share: false, company_ids }]) }).checkResponsible({ userId: 9, companyId: 2 })
  assert.equal((await run([1, 2])).inCompany, true)
  assert.equal((await run([[2, 'DIG']])).inCompany, true)
  assert.equal((await run([{ id: 2 }])).inCompany, true)
  for (const value of [[], [1, 3], ['2'], [[3, 'Other']], 2, false, null, 'DIG']) assert.equal((await run(value)).inCompany, false, JSON.stringify(value))
  const noShare = await createOdooClient({ ...base, fetch: mockFetch(200, [{ id: 9, active: true, company_ids: [2] }]) }).checkResponsible({ userId: 9, companyId: 2 })
  assert.equal(noShare.internal, false, 'a missing share flag is not proof of an internal user')
})

test('responsible check reads one fixed res.users record with fixed fields', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [], calls) })
  await client.checkResponsible({ userId: 9, companyId: 2, domain: [['id', '>', 0]], fields: ['password'] })
  assert.equal(calls[0].url, 'https://odoo.example.com/json/2/res.users/search_read')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.domain, [['id', '=', 9]])
  assert.deepEqual(body.fields, ['id', 'active', 'share', 'company_ids'])
  assert.equal(body.limit, 1)
  assert.equal(body.context.active_test, false)
  await assert.rejects(client.checkResponsible({ userId: 0, companyId: 2 }), OdooError)
  await assert.rejects(client.checkResponsible({ userId: 9, companyId: 0 }), OdooError)
})

test('employee read-back: one fixed hr.employee record in the company; user_id false means no Odoo user', async () => {
  const calls = []
  const rows = [{ id: 41, name: 'Jan de Vries', company_id: [2, 'DIG'], user_id: false, active: true }]
  const client = createOdooClient({ ...base, fetch: mockFetch(200, rows, calls) })
  assert.deepEqual(await client.readEmployee({ id: 41, companyId: 2 }), { id: 41, name: 'Jan de Vries', companyId: 2, planningRoleIds: null, userId: null, userLinked: false, active: true })
  assert.equal(calls[0].url, 'https://odoo.example.com/json/2/hr.employee/search_read')
  const body = JSON.parse(calls[0].init.body)
  // No company in the domain: an employee that ended up in another company is reported as such, not as missing.
  assert.deepEqual(body.domain, [['id', '=', 41]])
  assert.deepEqual(body.fields, ['id', 'name', 'company_id', 'user_id', 'active'])
  assert.deepEqual(body.context, { allowed_company_ids: [2], active_test: false })
  const withUser = createOdooClient({ ...base, fetch: mockFetch(200, [{ ...rows[0], user_id: [5, 'Jan'] }]) })
  const linked = await withUser.readEmployee({ id: 41, companyId: 2 })
  assert.equal(linked.userId, 5)
  assert.equal(linked.userLinked, true)
  const none = createOdooClient({ ...base, fetch: mockFetch(200, []) })
  assert.equal(await none.readEmployee({ id: 41, companyId: 2 }), null)
})

// ---- planning roles ----

test('create without roles sends none; with roles only the fixed set, from the configuration', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [41], calls) })
  await client.createEmployee(employee)
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body).vals_list[0]).sort(), ['company_id', 'date_version', 'hr_responsible_id', 'name', 'user_id'])
  await client.createEmployee({ ...employee, planningRoleIds: [3, 4], defaultPlanningRoleId: 3 })
  const vals = JSON.parse(calls[1].init.body).vals_list[0]
  assert.deepEqual(vals.planning_role_ids, [[6, 0, [3, 4]]], 'Odoo command "set"')
  assert.equal(vals.default_planning_role_id, 3)
  assert.equal(vals.user_id, false, 'still no Odoo user')
  await client.createEmployee({ ...employee, planningRoleIds: [3] })
  assert.equal('default_planning_role_id' in JSON.parse(calls[2].init.body).vals_list[0], false, 'no default unless given')
  // Other keys in the params are ignored, like before.
  await client.createEmployee({ ...employee, planningRoleIds: [3], planning_role_ids: [9], groups_id: [1] })
  assert.deepEqual(JSON.parse(calls[3].init.body).vals_list[0].planning_role_ids, [[6, 0, [3]]])
  assert.equal('groups_id' in JSON.parse(calls[3].init.body).vals_list[0], false)
})

test('create refuses odd roles before anything is sent', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [41], calls) })
  for (const extra of [
    { planningRoleIds: [0] }, { planningRoleIds: [-1] }, { planningRoleIds: [1.5] }, { planningRoleIds: ['3'] }, { planningRoleIds: [3, 3] },
    { planningRoleIds: [1, 2, 3, 4, 5, 6] }, { planningRoleIds: 'x' }, { planningRoleIds: [3], defaultPlanningRoleId: 4 }, { defaultPlanningRoleId: 3 },
    { planningRoleIds: [3], defaultPlanningRoleId: '3' },
  ]) {
    await assert.rejects(client.createEmployee({ ...employee, ...extra }), (error) => error instanceof OdooWriteError && error.outcome === 'rejected', JSON.stringify(extra))
  }
  assert.equal(calls.length, 0)
})

test('role check: one fixed planning.role read, and only the asked, existing ids come back', async () => {
  const calls = []
  const client = createOdooClient({ ...base, fetch: mockFetch(200, [{ id: 3 }, { id: 4 }, { id: 9 }, { id: 'x' }, null], calls) })
  assert.deepEqual(await client.checkPlanningRoles({ ids: [3, 4], companyId: 2, domain: [['id', '>', 0]], fields: ['name'] }), [3, 4])
  assert.equal(calls[0].url, 'https://odoo.example.com/json/2/planning.role/search_read')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.domain, [['id', 'in', [3, 4]]])
  assert.deepEqual(body.fields, ['id'])
  assert.deepEqual(body.context, { allowed_company_ids: [2] })
  const none = createOdooClient({ ...base, fetch: mockFetch(200, []) })
  assert.deepEqual(await none.checkPlanningRoles({ ids: [3], companyId: 2 }), [])
  for (const ids of [[], [0], ['3'], [1, 2, 3, 4, 5, 6], 'x']) {
    await assert.rejects(client.checkPlanningRoles({ ids, companyId: 2 }), OdooError, JSON.stringify(ids))
  }
  await assert.rejects(client.checkPlanningRoles({ ids: [3], companyId: 0 }), OdooError)
  const odd = createOdooClient({ ...base, fetch: mockFetch(200, { not: 'a list' }) })
  await assert.rejects(odd.checkPlanningRoles({ ids: [3], companyId: 2 }), OdooError)
})

test('employee read-back with roles asks for planning_role_ids, and reads ids only', async () => {
  const calls = []
  const rows = [{ id: 41, name: 'Jan', company_id: [2, 'DIG'], user_id: false, active: true, planning_role_ids: [3, 4] }]
  const client = createOdooClient({ ...base, fetch: mockFetch(200, rows, calls) })
  assert.deepEqual((await client.readEmployee({ id: 41, companyId: 2, planningRoles: true })).planningRoleIds, [3, 4])
  assert.deepEqual(JSON.parse(calls[0].init.body).fields, ['id', 'name', 'company_id', 'user_id', 'active', 'planning_role_ids'])
  assert.deepEqual((await client.readEmployee({ id: 41, companyId: 2 })).planningRoleIds, null, 'not asked for: not read')
  assert.deepEqual(JSON.parse(calls[1].init.body).fields, ['id', 'name', 'company_id', 'user_id', 'active'])
  for (const [value, expected] of [[[[3, 'Monteur']], [3]], [[{ id: 3 }], [3]], [false, []], [[], []], [[0, 'x', null], []], ['3', []]]) {
    const odd = createOdooClient({ ...base, fetch: mockFetch(200, [{ ...rows[0], planning_role_ids: value }]) })
    assert.deepEqual((await odd.readEmployee({ id: 41, companyId: 2, planningRoles: true })).planningRoleIds, expected, JSON.stringify(value))
  }
})

test('list of planning roles: one fixed planning.role read, names trimmed to rows that make sense', async () => {
  const calls = []
  const rows = [{ id: 1, name: 'Monteur' }, { id: 2, name: '  ' }, { id: 'x', name: 'Fout' }, { id: 0, name: 'Nul' }, { id: 3 }, null, { id: 4, name: 'P'.repeat(200) }]
  const client = createOdooClient({ ...base, fetch: mockFetch(200, rows, calls) })
  const roles = await client.listPlanningRoles({ companyId: 2, domain: [['id', '>', 0]], fields: ['name', 'resource_ids'], limit: 1 })
  assert.deepEqual(roles.map((role) => role.id), [1, 4])
  assert.equal(roles[1].name.length, 80, 'a long name is cut')
  assert.equal(calls[0].url, 'https://odoo.example.com/json/2/planning.role/search_read')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.domain, [])
  assert.deepEqual(body.fields, ['id', 'name'])
  assert.equal(body.order, 'name, id')
  assert.equal(body.limit, 200)
  assert.deepEqual(body.context, { allowed_company_ids: [2] })
  await assert.rejects(client.listPlanningRoles({ companyId: 0 }), OdooError)
  await assert.rejects(createOdooClient({ ...base, fetch: mockFetch(200, { no: 'list' }) }).listPlanningRoles({ companyId: 2 }), OdooError)
  assert.deepEqual(await createOdooClient({ ...base, fetch: mockFetch(200, []) }).listPlanningRoles({ companyId: 2 }), [])
})
