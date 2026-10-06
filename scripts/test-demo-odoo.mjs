// Tests of the demo Odoo (scripts/demo-odoo.mjs), which the rehearsal in docs/lokaal-testen.md relies on.
// Run: node --experimental-strip-types scripts/test-demo-odoo.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDemoOdoo } from './demo-odoo.mjs'

async function withDemo(run) {
  const lines = []
  const demo = createDemoOdoo({ log: (line) => lines.push(line) })
  await new Promise((resolve) => demo.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${demo.server.address().port}`
  const call = async (model, method, body = {}, { auth = true } = {}) => {
    const response = await fetch(`${base}/json/2/${model}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'bearer demo' } : {}) },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    await run({ call, demo, lines })
  } finally {
    await new Promise((resolve) => demo.server.close(resolve))
  }
}

const vals = { name: 'Piet Proef', company_id: 2, hr_responsible_id: 2, user_id: false, date_version: '2026-10-06' }
const context = { allowed_company_ids: [2] }

test('create answers with a list of ids and the employee can be read back as Odoo 20 would send it', async () => {
  await withDemo(async ({ call, demo, lines }) => {
    const created = await call('hr.employee', 'create', { vals_list: [vals], context })
    assert.equal(created.status, 200)
    assert.deepEqual(created.body, [900])
    const read = await call('hr.employee', 'search_read', { domain: [['id', '=', 900]], fields: ['id', 'name', 'company_id', 'user_id', 'active'], limit: 1, context })
    assert.deepEqual(read.body, [{ id: 900, name: 'Piet Proef', company_id: [2, 'Demo bedrijf'], user_id: false, active: true }])
    assert.equal(demo.employees.length, 1)
    assert.match(lines.join('\n'), /CREATE hr\.employee .*"user_id":false/)
    assert.deepEqual((await call('hr.employee', 'search_read', { domain: [['id', '=', 1]], fields: ['id'] })).body, [], 'another id is not found')
  })
})

test('create is as strict as Odoo: unknown fields, missing context, wrong company and unknown responsible are errors', async () => {
  await withDemo(async ({ call, demo }) => {
    const fails = async (body, status) => {
      const answer = await call('hr.employee', 'create', body)
      assert.equal(answer.status, status, JSON.stringify(body))
      assert.equal(typeof answer.body.message, 'string')
    }
    await fails({ vals_list: [{ ...vals, groups_id: [1] }], context }, 500)
    await fails({ vals_list: [{ ...vals, name: '  ' }], context }, 500)
    await fails({ vals_list: [vals] }, 500)
    await fails({ vals_list: [{ ...vals, company_id: 3 }], context }, 403)
    await fails({ vals_list: [{ ...vals, hr_responsible_id: 99 }], context }, 500)
    await fails({ vals: vals, context }, 422)
    assert.equal(demo.employees.length, 0, 'nothing was created')
  })
})

test('every create makes a new employee: the demo has no idempotency, so retries must be stopped by the dashboard and gateway', async () => {
  await withDemo(async ({ call, demo }) => {
    await call('hr.employee', 'create', { vals_list: [vals], context })
    await call('hr.employee', 'create', { vals_list: [vals], context })
    assert.equal(demo.employees.length, 2)
  })
})

test('res.users: a responsible is found as [id active share company_ids]; inactive ones only with active_test false', async () => {
  await withDemo(async ({ call }) => {
    const read = (id, extra = {}) => call('res.users', 'search_read', { domain: [['id', '=', id]], fields: ['id', 'active', 'share', 'company_ids'], limit: 1, context: { ...context, ...extra } })
    assert.deepEqual((await read(2)).body, [{ id: 2, active: true, share: false, company_ids: [1, 2] }])
    assert.deepEqual((await read(3)).body, [{ id: 3, active: true, share: true, company_ids: [1, 2] }])
    assert.deepEqual((await read(4)).body, [], 'inactive and hidden by default')
    assert.deepEqual((await read(4, { active_test: false })).body, [{ id: 4, active: false, share: false, company_ids: [1, 2] }])
    assert.deepEqual((await read(99)).body, [])
  })
})

test('the planning data and the key check still work', async () => {
  await withDemo(async ({ call }) => {
    assert.equal((await call('planning.slot', 'search_count')).status, 200)
    const rows = (await call('planning.slot', 'search_read', { fields: ['id', 'name'], limit: 2 })).body
    assert.equal(rows.length, 2)
    assert.deepEqual(Object.keys(rows[0]), ['id', 'name'])
    assert.equal((await call('planning.slot', 'search_read', {}, { auth: false })).status, 401)
    assert.equal((await call('nope.model', 'search_read')).status, 404)
  })
})
