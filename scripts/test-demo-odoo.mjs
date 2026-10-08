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

test('planning roles: set by an Odoo "set" command, read back as a list of ids, and only existing active roles are accepted', async () => {
  await withDemo(async ({ call, demo, lines }) => {
    const withRoles = { ...vals, planning_role_ids: [[6, 0, [1, 2]]], default_planning_role_id: 1 }
    assert.deepEqual((await call('hr.employee', 'create', { vals_list: [withRoles], context })).body, [900])
    const read = await call('hr.employee', 'search_read', { domain: [['id', '=', 900]], fields: ['id', 'planning_role_ids', 'default_planning_role_id'], limit: 1, context })
    assert.deepEqual(read.body, [{ id: 900, planning_role_ids: [1, 2], default_planning_role_id: [1, 'Monteur'] }])
    assert.match(lines.join('\n'), /planning_role_ids/)
    const fails = async (extra) => {
      const answer = await call('hr.employee', 'create', { vals_list: [{ ...vals, ...extra }], context })
      assert.equal(answer.status, 500, JSON.stringify(extra))
    }
    await fails({ planning_role_ids: [[6, 0, [99]]] })
    await fails({ planning_role_ids: [[6, 0, [3]]] }) // archived
    await fails({ planning_role_ids: [1, 2] }) // not a command
    await fails({ planning_role_ids: [[4, 1]] }) // another command
    await fails({ planning_role_ids: [[6, 0, [1]]], default_planning_role_id: 2 }) // default not among the roles
    await fails({ default_planning_role_id: 1 }) // default without roles
    assert.equal(demo.employees.length, 1, 'only the first one was made')
    const none = await call('hr.employee', 'create', { vals_list: [vals], context })
    assert.equal(none.status, 200)
    const readNone = await call('hr.employee', 'search_read', { domain: [['id', '=', 901]], fields: ['planning_role_ids', 'default_planning_role_id'], limit: 1, context })
    assert.deepEqual(readNone.body, [{ planning_role_ids: [], default_planning_role_id: false }])
  })
})

test('planning.role: only the asked ids that exist; archived ones only with active_test false', async () => {
  await withDemo(async ({ call }) => {
    const read = (ids, extra = {}) => call('planning.role', 'search_read', { domain: [['id', 'in', ids]], fields: ['id'], limit: 5, context: { ...context, ...extra } })
    assert.deepEqual((await read([1, 2, 3, 99])).body, [{ id: 1 }, { id: 2 }])
    assert.deepEqual((await read([3], { active_test: false })).body, [{ id: 3 }])
    assert.deepEqual((await read([99])).body, [])
    const everything = await call('planning.role', 'search_read', { domain: [], fields: ['id', 'name'], order: 'name, id', limit: 200, context })
    assert.deepEqual(everything.body, [{ id: 1, name: 'Monteur' }, { id: 2, name: 'Planner' }], 'the list: active roles by name, the archived one left out')
  })
})

test('hr.employee write: changes the planning roles of an existing employee, as strict as create, and nothing else', async () => {
  await withDemo(async ({ call, demo, lines }) => {
    await call('hr.employee', 'create', { vals_list: [vals], context })
    const read = async () => (await call('hr.employee', 'search_read', { domain: [['id', '=', 900]], fields: ['planning_role_ids', 'default_planning_role_id'], limit: 1, context })).body[0]
    const write = (extra, ids = [900]) => call('hr.employee', 'write', { ids, vals: extra, context })
    assert.deepEqual(await read(), { planning_role_ids: [], default_planning_role_id: false })

    const set = await write({ planning_role_ids: [[6, 0, [2, 1]]], default_planning_role_id: 2 })
    assert.deepEqual([set.status, set.body], [200, true])
    assert.deepEqual(await read(), { planning_role_ids: [2, 1], default_planning_role_id: [2, 'Planner'] })
    assert.match(lines.join('\n'), /WRITE hr\.employee \[900\] .*planning_role_ids/)

    assert.equal((await write({ planning_role_ids: [[6, 0, []]], default_planning_role_id: false })).status, 200)
    assert.deepEqual(await read(), { planning_role_ids: [], default_planning_role_id: false }, 'cleared')

    const before = JSON.stringify(demo.employees)
    const fails = async (extra, status, ids = [900]) => {
      const answer = await write(extra, ids)
      assert.equal(answer.status, status, JSON.stringify(extra))
      assert.equal(typeof answer.body.message, 'string')
    }
    await fails({ planning_role_ids: [[6, 0, [99]]] }, 500)
    await fails({ planning_role_ids: [[6, 0, [3]]] }, 500) // archived
    await fails({ planning_role_ids: [1, 2] }, 500) // not a command
    await fails({ planning_role_ids: [[4, 1]] }, 500)
    await fails({ planning_role_ids: [[6, 0, [1]]], default_planning_role_id: 2 }, 500) // default not among the roles
    await fails({ default_planning_role_id: 1 }, 500) // default without roles
    await fails({ name: 'Andere naam' }, 500) // not a planning role field
    await fails({ user_id: 2 }, 500) // never a user
    await fails({ planning_role_ids: [[6, 0, [1]]] }, 404, [999]) // unknown employee
    assert.equal((await call('hr.employee', 'write', { ids: [900], vals: { planning_role_ids: [[6, 0, [1]]] } })).status, 500, 'no company in the context')
    assert.equal((await call('hr.employee', 'write', { vals: {}, context })).status, 422)
    assert.equal(JSON.stringify(demo.employees), before, 'a refused write changes nothing')
  })
})

test('hr.employee write: the roles are replaced as a whole, and a default that is no longer among them goes away', async () => {
  await withDemo(async ({ call }) => {
    await call('hr.employee', 'create', { vals_list: [{ ...vals, planning_role_ids: [[6, 0, [1, 2]]], default_planning_role_id: 1 }], context })
    const write = (extra) => call('hr.employee', 'write', { ids: [900], vals: extra, context })
    assert.equal((await write({ planning_role_ids: [[6, 0, [2]]] })).status, 200)
    const row = (await call('hr.employee', 'search_read', { domain: [['id', '=', 900]], fields: ['planning_role_ids', 'default_planning_role_id'], limit: 1, context })).body[0]
    assert.deepEqual(row, { planning_role_ids: [2], default_planning_role_id: false })
  })
})

test('an employee has a resource, a working schedule and a time zone, as Odoo has', async () => {
  await withDemo(async ({ call }) => {
    await call('hr.employee', 'create', { vals_list: [vals], context })
    const read = await call('hr.employee', 'search_read', { domain: [['id', '=', 900]], fields: ['resource_id', 'resource_calendar_id', 'tz'], limit: 1, context })
    assert.deepEqual(read.body, [{ resource_id: [5900, 'Piet Proef'], resource_calendar_id: [1, 'Standaard 40 uur'], tz: 'Europe/Amsterdam' }])
  })
})

test('resource.calendar.leaves: one record for the resource of an employee, read back by id, and removed', async () => {
  await withDemo(async ({ call, demo, lines }) => {
    await call('hr.employee', 'create', { vals_list: [vals], context })
    const leave = { name: '[Dashboard] Niet beschikbaar: Vakantie', resource_id: 5900, calendar_id: 1, date_from: '2026-10-11 22:00:00', date_to: '2026-10-13 21:59:59' }
    const created = await call('resource.calendar.leaves', 'create', { vals_list: [leave], context })
    assert.deepEqual([created.status, created.body], [200, [7000]])
    assert.match(lines.join('\n'), /CREATE resource\.calendar\.leaves .*"resource_id":5900/)
    const read = await call('resource.calendar.leaves', 'search_read', { domain: [['id', '=', 7000]], fields: ['id', 'name', 'resource_id', 'date_from', 'date_to'], limit: 1, context })
    assert.deepEqual(read.body, [{ id: 7000, name: leave.name, resource_id: [5900, 'Piet Proef'], date_from: leave.date_from, date_to: leave.date_to }])
    assert.deepEqual((await call('resource.calendar.leaves', 'search_read', { domain: [['id', '=', 7001]], fields: ['id'], context })).body, [])
    const removed = await call('resource.calendar.leaves', 'unlink', { ids: [7000], context })
    assert.deepEqual([removed.status, removed.body], [200, true])
    assert.equal(demo.leaves.length, 0)
    assert.equal((await call('resource.calendar.leaves', 'unlink', { ids: [7000], context })).status, 404, 'a record that is gone is an error, as in Odoo')
  })
})

test('resource.calendar.leaves is as strict as Odoo: unknown fields, unknown resource, odd dates and an end before the start are errors', async () => {
  await withDemo(async ({ call, demo }) => {
    await call('hr.employee', 'create', { vals_list: [vals], context })
    const leave = { name: 'x', resource_id: 5900, date_from: '2026-10-11 22:00:00', date_to: '2026-10-13 21:59:59' }
    const fails = async (extra) => {
      const answer = await call('resource.calendar.leaves', 'create', { vals_list: [{ ...leave, ...extra }], context })
      assert.equal(answer.status, 500, JSON.stringify(extra))
    }
    await fails({ user_id: 2 })
    await fails({ company_id: 2 })
    await fails({ resource_id: 99 })
    await fails({ resource_id: false })
    await fails({ calendar_id: 9 })
    await fails({ name: '  ' })
    await fails({ date_from: '2026-10-11' })
    await fails({ date_to: '2026-10-11 22:00:00' })
    await fails({ date_from: '2026-10-14 00:00:00' })
    assert.equal((await call('resource.calendar.leaves', 'create', { vals: leave, context })).status, 422)
    assert.equal(demo.leaves.length, 0, 'nothing was created')
  })
})

const PDF = Buffer.from('%PDF-1.4\nvoorbeeld\n%%EOF\n').toString('base64')
const attachment = { name: 'schouw-jansen-20261008.pdf', type: 'binary', datas: PDF, mimetype: 'application/pdf', res_model: 'res.partner', res_id: 101 }

test('planning.slot and svs.tech.visit can be read by id (customer included); an id without a record gives nothing', async () => {
  await withDemo(async ({ call }) => {
    const slot = await call('planning.slot', 'search_read', { domain: [['id', '=', 1], ['company_id', '=', 2]], fields: ['id', 'partner_id'], limit: 1, context })
    assert.deepEqual(slot.body, [{ id: 1, partner_id: [101, 'Familie Jansen'] }])
    const visit = await call('svs.tech.visit', 'search_read', { domain: [['id', '=', 106]], fields: ['id', 'partner_id'], limit: 1 })
    assert.deepEqual(visit.body, [{ id: 106, partner_id: false }], 'a visit without a customer')
    assert.deepEqual((await call('planning.slot', 'search_read', { domain: [['id', '=', 999]], fields: ['id'] })).body, [])
    assert.ok((await call('planning.slot', 'search_read', { domain: [], fields: ['id'] })).body.length > 1, 'without an id filter it still lists everything')
  })
})

test('ir.attachment/create then res.partner/message_post: the file is on the customer, the note is internal and sends nothing', async () => {
  await withDemo(async ({ call, demo, lines }) => {
    const created = await call('ir.attachment', 'create', { vals_list: [attachment], context })
    assert.deepEqual([created.status, created.body], [200, [8000]])
    assert.equal(demo.attachments.length, 1)
    assert.equal(demo.attachments[0].bytes.subarray(0, 5).toString('latin1'), '%PDF-')
    const noted = await call('res.partner', 'message_post', {
      ids: [101], body: 'Schouwdocument - Familie Jansen', message_type: 'comment', subtype_xmlid: 'mail.mt_note', attachment_ids: [8000],
      context: { ...context, mail_post_autofollow: false },
    })
    assert.deepEqual([noted.status, noted.body], [200, 9000])
    assert.deepEqual(demo.notes, [{ id: 9000, partnerId: 101, body: 'Schouwdocument - Familie Jansen', attachmentIds: [8000] }])
    const text = lines.join('\n')
    assert.match(text, /ATTACH ir\.attachment 8000 "schouw-jansen-20261008\.pdf" \(\d+ bytes\) on res\.partner 101 \(Familie Jansen\)/)
    assert.match(text, /NOTE res\.partner 101 \(Familie Jansen\) internal note 9000 .* no mail, no recipients/)
  })
})

test('ir.attachment/create is as strict as Odoo: unknown fields, other models, unknown customers, no context and bad data are errors', async () => {
  await withDemo(async ({ call, demo }) => {
    const fails = async (body, status) => {
      const answer = await call('ir.attachment', 'create', body)
      assert.equal(answer.status, status, JSON.stringify(body).slice(0, 80))
    }
    await fails({ vals_list: [{ ...attachment, public: true }], context }, 500)
    await fails({ vals_list: [{ ...attachment, res_model: 'res.users' }], context }, 500)
    await fails({ vals_list: [{ ...attachment, res_id: 5 }], context }, 500)
    await fails({ vals_list: [{ ...attachment, name: ' ' }], context }, 500)
    await fails({ vals_list: [{ ...attachment, datas: 'not base64!' }], context }, 500)
    await fails({ vals_list: [attachment] }, 500)
    await fails({ vals: attachment, context }, 422)
    assert.equal(demo.attachments.length, 0, 'nothing was created')
  })
})

test('res.partner/message_post is as strict as Odoo: only an internal note with an attachment of that customer; unknown arguments are errors', async () => {
  await withDemo(async ({ call, demo }) => {
    await call('ir.attachment', 'create', { vals_list: [attachment], context })
    const good = { ids: [101], body: 'x', message_type: 'comment', subtype_xmlid: 'mail.mt_note', attachment_ids: [8000], context }
    const fails = async (extra, status) => {
      const answer = await call('res.partner', 'message_post', { ...good, ...extra })
      assert.equal(answer.status, status, JSON.stringify(extra))
    }
    await fails({ partner_ids: [101] }, 422)
    await fails({ subtype_xmlid: 'mail.mt_comment' }, 500)
    await fails({ message_type: 'email' }, 500)
    await fails({ ids: [999] }, 404)
    await fails({ ids: [101, 102] }, 404)
    await fails({ attachment_ids: [8001] }, 404)
    await fails({ ids: [102] }, 404)
    await fails({ body: ' ' }, 500)
    await fails({ context: undefined }, 500)
    assert.equal(demo.notes.length, 0, 'no note was posted')
  })
})
