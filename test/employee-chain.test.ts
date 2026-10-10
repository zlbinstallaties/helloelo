import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGateway } from '../gateway/src/server.ts'
import { parseProjects, sha256Hex } from '../gateway/src/projects.ts'
import { createOdooClient } from '../src/lib/odoo-client.ts'
import { createEmployeeViaGateway, listPlanningRolesViaGateway, readEmployeeRolesViaGateway, setEmployeeRolesViaGateway } from '../src/lib/gateway-employee.ts'
import { GENERATED, login, read, request, setup } from './api-helpers.ts'

/*
 * The whole chain with mocks only: a request to the dashboard, the dashboard service, the call to the gateway, the
 * real gateway, the real Odoo client, and a mock of the HTTP connection to Odoo that records everything Odoo
 * would have received. Nothing here is a real Odoo.
 */

const TOKEN = 'dashboard-live-token-123'
const REQUEST = 'req-0123456789abcdef'

type Wire = { path: string; body: Record<string, any> }

function amsterdamToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date())
}

function mockOdoo() {
  const wire: Wire[] = []
  const employees: Array<{ id: number; name: string; company_id: [number, string]; user_id: false | [number, string]; planning_role_ids: number[]; default_planning_role_id: false | number; active: boolean }> = []
  const mode = {
    responsible: { id: 9, active: true, share: false, company_ids: [2] } as Record<string, unknown> | null,
    create: 'ok' as 'ok' | 'refuse' | 'lost',
    userOnRead: false,
    readFails: false,
    write: 'ok' as 'ok' | 'refuse' | 'lost',
    /** The planning.role records that exist and are active. */
    roles: [3, 4] as number[],
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
    wire.push({ path, body })
    if (path === '/json/2/res.users/search_read') return json(200, mode.responsible ? [mode.responsible] : [])
    if (path === '/json/2/planning.role/search_read') {
      // An empty domain is the list for the planner; otherwise it is the check of chosen ids.
      if (body.domain.length === 0) return json(200, mode.roles.map((id) => ({ id, name: `Rol ${id}` })))
      const asked = body.domain[0][2] as number[]
      return json(200, mode.roles.filter((id) => asked.includes(id)).map((id) => ({ id })))
    }
    if (path === '/json/2/hr.employee/create') {
      if (mode.create === 'refuse') return json(403, { name: 'odoo.exceptions.AccessError', message: 'Access denied' })
      const vals = body.vals_list[0]
      const record = { id: 41 + employees.length, name: vals.name as string, company_id: [vals.company_id, 'DIG'] as [number, string], user_id: vals.user_id as false, planning_role_ids: ((vals.planning_role_ids?.[0]?.[2] ?? []) as number[]), default_planning_role_id: (vals.default_planning_role_id ?? false) as false | number, active: true }
      employees.push(record)
      // "lost": Odoo created the employee, but the answer never arrived.
      if (mode.create === 'lost') throw new TypeError('connection reset')
      return json(200, [record.id])
    }
    if (path === '/json/2/hr.employee/write') {
      if (mode.write === 'refuse') return json(403, { name: 'odoo.exceptions.AccessError', message: 'Access denied' })
      const target = employees.find((employee) => body.ids.length === 1 && employee.id === body.ids[0])
      if (!target) return json(404, { name: 'odoo.exceptions.MissingError', message: 'record does not exist' })
      target.planning_role_ids = (body.vals.planning_role_ids?.[0]?.[2] ?? []) as number[]
      target.default_planning_role_id = (body.vals.default_planning_role_id ?? false) as false | number
      if (mode.write === 'lost') throw new TypeError('connection reset')
      return json(200, true)
    }
    if (path === '/json/2/hr.employee/search_read') {
      if (mode.readFails) throw new TypeError('connection reset')
      const wanted = body.domain.find((term: unknown[]) => term[0] === 'id')[2]
      const found = employees.filter((employee) => employee.id === wanted).map((employee) => ({ ...employee, user_id: mode.userOnRead ? [5, 'Een gebruiker'] : employee.user_id }))
      return json(200, found)
    }
    return json(404, { name: 'odoo.exceptions.MissingError', message: 'unknown' })
  }) as unknown as typeof fetch
  return { wire, employees, mode, fetchImpl }
}

async function chain(options: { actionOn?: boolean; lostAnswer?: boolean; allowedRoles?: number[]; rolesActionOff?: boolean } = {}) {
  const odoo = mockOdoo()
  const projects = parseProjects({
    projects: [
      {
        id: 'dashboard-live',
        tokenSha256: sha256Hex(TOKEN),
        companyId: 2,
        models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } },
        ...(options.actionOn === false ? {} : { actions: { createEmployee: { responsibleUserId: 9, ...(options.allowedRoles && { allowedPlanningRoleIds: options.allowedRoles }) }, ...(options.rolesActionOff ? {} : { setEmployeePlanningRoles: { ...(options.allowedRoles && { allowedPlanningRoleIds: options.allowedRoles }) } }) } }),
      },
    ],
  })
  const client = createOdooClient({ baseUrl: 'https://odoo.example.com', apiKey: 'odoo-key', allowedModels: ['planning.slot'], fetch: odoo.fetchImpl })
  const server = createServer(createGateway({ projects, odoo: client, log: () => {} }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const toGateway = {
    attempts: 0,
    lostAnswers: options.lostAnswer === true,
  }
  // The dashboard's call to the gateway; with `lostAnswer` the gateway does its work but the answer never arrives.
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    toGateway.attempts += 1
    const response = await fetch(input, init)
    if (toGateway.lostAnswers) throw new TypeError('connection reset')
    return response
  }) as unknown as typeof fetch
  const api = setup({
    createEmployee: (input) => createEmployeeViaGateway({ url, token: TOKEN, requestId: input.requestId, name: input.name, planningRoleIds: input.planningRoleIds, fetchImpl, timeoutMs: 5000 }),
    listPlanningRoles: () => listPlanningRolesViaGateway({ url, token: TOKEN, timeoutMs: 5000 }),
    getEmployeeRoles: (employeeId) => readEmployeeRolesViaGateway({ url, token: TOKEN, employeeId, timeoutMs: 5000 }),
    setEmployeeRoles: (employeeId, planningRoleIds) => setEmployeeRolesViaGateway({ url, token: TOKEN, employeeId, planningRoleIds, timeoutMs: 5000 }),
  })
  return { api, odoo, toGateway, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const post = async (c: Awaited<ReturnType<typeof chain>>, cookie: string | undefined, body: Record<string, unknown> = {}) =>
  read(await c.api.handlers.employeesCreate(request('/api/employees', { method: 'POST', cookie, body: { requestId: REQUEST, name: 'Els Bakker', username: 'els', ...body } })))

const planner = async (c: Awaited<ReturnType<typeof chain>>) => (await login(c.api, 'planner')).cookie
const creates = (c: Awaited<ReturnType<typeof chain>>) => c.odoo.wire.filter((entry) => entry.path.endsWith('/create'))

async function withChain(run: (c: Awaited<ReturnType<typeof chain>>) => Promise<void>, options: Parameters<typeof chain>[0] = {}) {
  const c = await chain(options)
  try {
    await run(c)
  } finally {
    await c.close()
  }
}

test('chain: a planner adds a technician; Odoo only ever receives an employee without an Odoo user', async () => {
  await withChain(async (c) => {
    const answer = await post(c, await planner(c))
    assert.equal(answer.status, 201)
    assert.equal(answer.json.employeeId, 41)
    assert.equal(answer.json.verified, true)
    assert.equal(answer.json.account.personId, 'employee:41')
    assert.equal(answer.json.password, GENERATED)

    assert.deepEqual(c.odoo.wire.map((entry) => entry.path), ['/json/2/res.users/search_read', '/json/2/hr.employee/create', '/json/2/hr.employee/search_read'])
    const [created] = creates(c)
    assert.deepEqual(created.body.vals_list, [{ name: 'Els Bakker', company_id: 2, hr_responsible_id: 9, user_id: false, date_version: amsterdamToday() }])
    assert.equal(created.body.vals_list.length, 1, 'one employee')
    assert.deepEqual(created.body.context.allowed_company_ids, [2])
    assert.deepEqual(c.odoo.employees.map((employee) => employee.user_id), [false], 'the employee in Odoo has no user')
    // Nothing else: no res.users create or write, no planning, no unlink.
    for (const entry of c.odoo.wire) assert.ok(!/res\.users\/(create|write|unlink)|planning\.|\/write$|\/unlink$/.test(entry.path), entry.path)
  })
})

test('chain: the company comes from the gateway config; nothing from the browser reaches Odoo', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const sneaky = await post(c, cookie, { company_id: 3, companyId: 3, hr_responsible_id: 5, user_id: 5, vals: { user_id: 5 } })
    assert.equal(sneaky.status, 400)
    assert.equal(c.odoo.wire.length, 0, 'refused before anything went to Odoo')
    const fine = await post(c, cookie)
    assert.equal(fine.status, 201)
    assert.equal(creates(c)[0].body.vals_list[0].company_id, 2)
    assert.equal(creates(c)[0].body.vals_list[0].hr_responsible_id, 9)
  })
})

test('chain: a visitor who is not logged in and a monteur reach neither the gateway nor Odoo', async () => {
  await withChain(async (c) => {
    assert.equal((await post(c, undefined)).status, 401)
    assert.equal((await post(c, (await login(c.api, 'jan')).cookie)).status, 403)
    assert.equal(c.toGateway.attempts, 0)
    assert.equal(c.odoo.wire.length, 0)
    assert.equal(c.api.accounts.list().length, 2)
  })
})

test('chain: a responsible who is not allowed for the company stops everything before an employee is made', async () => {
  const bad: Array<Record<string, unknown> | null> = [
    null,
    { id: 9, active: false, share: false, company_ids: [2] },
    { id: 9, active: true, share: true, company_ids: [2] },
    { id: 9, active: true, share: false, company_ids: [3] },
  ]
  for (const responsible of bad) {
    await withChain(async (c) => {
      c.odoo.mode.responsible = responsible
      const answer = await post(c, await planner(c))
      assert.equal(answer.status, 502, JSON.stringify(responsible))
      assert.match(answer.json.error, /verantwoordelijke/)
      assert.equal(creates(c).length, 0)
      assert.equal(c.odoo.employees.length, 0)
      assert.equal(c.api.accounts.list().length, 2, 'no account')
    })
  }
})

test('chain: the action is off for this token: a clear error, and Odoo is not touched', async () => {
  await withChain(async (c) => {
    const answer = await post(c, await planner(c))
    assert.equal(answer.status, 503)
    assert.match(answer.json.error, /staat niet aan/)
    assert.equal(c.odoo.wire.length, 0)
    assert.equal(c.api.accounts.list().length, 2)
  }, { actionOn: false })
})

test('chain: Odoo refuses the creation: an error, no account, and trying again later makes exactly one employee', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    c.odoo.mode.create = 'refuse'
    const refused = await post(c, cookie)
    assert.equal(refused.status, 502)
    assert.match(refused.json.error, /geweigerd/)
    assert.equal(c.api.accounts.list().length, 2)
    assert.equal(c.odoo.employees.length, 0)
    c.odoo.mode.create = 'ok'
    const retry = await post(c, cookie)
    assert.equal(retry.status, 201)
    assert.equal(c.odoo.employees.length, 1)
    assert.equal(c.api.accounts.list().length, 3)
  })
})

test('chain: Odoo made the employee but the answer was lost: no account, and no second employee however often it is repeated', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    c.odoo.mode.create = 'lost'
    const first = await post(c, cookie)
    assert.equal(first.status, 504)
    assert.match(first.json.error, /niet zeker/)
    assert.equal(c.odoo.employees.length, 1)
    assert.equal(c.api.accounts.list().length, 2, 'no account for an employee that is not confirmed')
    c.odoo.mode.create = 'ok'
    for (let i = 0; i < 3; i++) assert.equal((await post(c, cookie)).status, 409)
    assert.equal(creates(c).length, 1, 'Odoo was asked to create once')
    assert.equal(c.odoo.employees.length, 1)
  })
})

test('chain: the gateway did its work but its answer never reached the dashboard: the same', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const first = await post(c, cookie)
    assert.equal(first.status, 504)
    assert.equal(c.odoo.employees.length, 1)
    assert.equal(c.api.accounts.list().length, 2)
    c.toGateway.lostAnswers = false
    assert.equal((await post(c, cookie)).status, 409)
    assert.equal(c.toGateway.attempts, 1, 'the gateway was not asked again')
    assert.equal(c.odoo.employees.length, 1)
  }, { lostAnswer: true })
})

test('chain: two clicks at once make one employee and one account', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const [one, two] = await Promise.all([post(c, cookie), post(c, cookie)])
    assert.deepEqual([one.status, two.status].sort(), [201, 409])
    assert.equal(c.odoo.employees.length, 1)
    assert.equal(creates(c).length, 1)
    assert.equal(c.api.accounts.list().length, 3)
  })
})

test('chain: a repeat after success gives the same employee and asks Odoo nothing', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const first = await post(c, cookie)
    const wireAfterFirst = c.odoo.wire.length
    const again = await post(c, cookie)
    assert.equal(again.status, 200)
    assert.equal(again.json.replayed, true)
    assert.equal(again.json.employeeId, first.json.employeeId)
    assert.equal(c.odoo.wire.length, wireAfterFirst, 'no call to Odoo at all')
  })
})

test('chain: if the employee turns out to have an Odoo user, it is reported and gets no portal account', async () => {
  await withChain(async (c) => {
    c.odoo.mode.userOnRead = true
    const answer = await post(c, await planner(c))
    assert.equal(answer.status, 500)
    assert.match(answer.json.error, /41/)
    assert.equal(answer.json.employeeId, 41)
    assert.equal(c.api.accounts.list().length, 2)
    assert.equal((await post(c, await planner(c))).status, 409)
    assert.equal(creates(c).length, 1)
  })
})

test('chain: when reading back fails the employee is still reported as made, not as verified', async () => {
  await withChain(async (c) => {
    c.odoo.mode.readFails = true
    const answer = await post(c, await planner(c))
    assert.equal(answer.status, 201)
    assert.equal(answer.json.verified, false)
    assert.equal(answer.json.account.personId, 'employee:41')
  })
})

test('chain: two technicians with the same name are two employees and two accounts, told apart by their id', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    await post(c, cookie)
    await post(c, cookie, { requestId: 'req-second-0123456789', username: 'els2' })
    assert.deepEqual(c.odoo.employees.map((employee) => [employee.id, employee.name]), [[41, 'Els Bakker'], [42, 'Els Bakker']])
    assert.deepEqual(c.api.accounts.list().filter((a) => a.name === 'Els Bakker').map((a) => a.personId).sort(), ['employee:41', 'employee:42'])
  })
})

const rolesList = async (c: Awaited<ReturnType<typeof chain>>, cookie: string | undefined) =>
  read(await c.api.handlers.planningRolesList(request('/api/planning-roles', { cookie })))

test('chain: the planner sees the roles of Odoo, chooses some, and Odoo gets exactly those (the first is the default)', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const list = await rolesList(c, cookie)
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.roles, [{ id: 3, name: 'Rol 3' }, { id: 4, name: 'Rol 4' }])

    const answer = await post(c, cookie, { planningRoleIds: [4, 3] })
    assert.equal(answer.status, 201)
    assert.equal(answer.json.planningRoles, 2)
    assert.deepEqual(c.odoo.wire.map((entry) => entry.path), [
      '/json/2/planning.role/search_read', '/json/2/res.users/search_read', '/json/2/planning.role/search_read', '/json/2/hr.employee/create', '/json/2/hr.employee/search_read',
    ])
    const [created] = creates(c)
    assert.deepEqual(created.body.vals_list, [{
      name: 'Els Bakker', company_id: 2, hr_responsible_id: 9, user_id: false, date_version: amsterdamToday(),
      planning_role_ids: [[6, 0, [4, 3]]], default_planning_role_id: 4,
    }])
    assert.deepEqual(c.odoo.employees.map((employee) => employee.planning_role_ids), [[4, 3]])
    const again = await post(c, cookie, { planningRoleIds: [4, 3] })
    assert.equal(again.json.planningRoles, 2, 'a repeat tells the same')
    assert.equal(creates(c).length, 1)
    assert.equal((await post(c, cookie, { planningRoleIds: [3, 4] })).status, 409, 'other order or other roles: not the same request')
    assert.equal(creates(c).length, 1)
  })
})

test('chain: odd roles from the browser are refused before the gateway or Odoo hear anything', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    for (const planningRoleIds of ['3', 3, null, [0], [-1], [1.5], ['3'], [3, 3], [1, 2, 3, 4, 5, 6]]) {
      const answer = await post(c, cookie, { planningRoleIds })
      assert.equal(answer.status, 400, JSON.stringify(planningRoleIds))
    }
    const sneaky = await post(c, cookie, { planning_role_ids: [[6, 0, [1]]], defaultPlanningRoleId: 1 })
    assert.equal(sneaky.status, 400)
    assert.equal(c.odoo.wire.length, 0)
  })
})

test('chain: a chosen role that is gone stops everything before an employee is made, and trying again works once it is back', async () => {
  await withChain(async (c) => {
    c.odoo.mode.roles = [3]
    const cookie = await planner(c)
    const refused = await post(c, cookie, { planningRoleIds: [3, 4] })
    assert.equal(refused.status, 502)
    assert.match(String(refused.json.error), /planningsrol/i)
    assert.equal(refused.json.retry, 'safe')
    assert.equal(creates(c).length, 0)
    c.odoo.mode.roles = [3, 4]
    assert.equal((await post(c, cookie, { planningRoleIds: [3, 4] })).status, 201, 'the same request works once the role is back')
    assert.equal(creates(c).length, 1)
  })
})

test('chain: a project that limits the roles shows and accepts only those', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    assert.deepEqual((await rolesList(c, cookie)).json.roles, [{ id: 3, name: 'Rol 3' }])
    const refused = await post(c, cookie, { planningRoleIds: [4] })
    assert.equal(refused.status, 502)
    assert.match(String(refused.json.error), /planningsrol/i)
    assert.equal(creates(c).length, 0)
    assert.equal((await post(c, cookie, { planningRoleIds: [3] })).status, 201)
  }, { allowedRoles: [3] })
})

test('chain: without roles chosen the planner is told that none were set, and Odoo is not asked about roles', async () => {
  await withChain(async (c) => {
    const answer = await post(c, await planner(c))
    assert.equal(answer.json.planningRoles, 0)
    assert.ok(!c.odoo.wire.some((entry) => entry.path.includes('planning.role')), 'no role check without roles')
    assert.ok(!('planning_role_ids' in creates(c)[0].body.vals_list[0]))
  })
})

test('chain: a monteur and a visitor cannot list the roles, and the gateway is not asked', async () => {
  await withChain(async (c) => {
    const monteur = (await login(c.api, 'jan')).cookie
    assert.equal((await rolesList(c, monteur)).status, 403)
    assert.equal((await rolesList(c, undefined)).status, 401)
    assert.equal(c.odoo.wire.length, 0)
  })
})

// ---- changing the planning roles of a technician who exists already ----

const rolesPath = (id: string) => `/api/accounts/${id}/planning-roles`
const getRoles = async (c: Awaited<ReturnType<typeof chain>>, cookie: string | undefined, id: string) => read(await c.api.handlers.accountRolesGet(request(rolesPath(id), { cookie }), id))
const putRoles = async (c: Awaited<ReturnType<typeof chain>>, cookie: string | undefined, id: string, body: unknown) =>
  read(await c.api.handlers.accountRolesSet(request(rolesPath(id), { method: 'PUT', cookie, body }), id))
const writes = (c: Awaited<ReturnType<typeof chain>>) => c.odoo.wire.filter((entry) => entry.path.endsWith('/write'))

async function technician(c: Awaited<ReturnType<typeof chain>>, cookie: string | undefined, body: Record<string, unknown> = {}) {
  const made = await post(c, cookie, body)
  assert.equal(made.status, 201)
  return made.json.account.id as string
}

test('chain: a technician made without roles gets them later; Odoo receives one write for that employee with only the roles and the default', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const id = await technician(c, cookie)
    assert.deepEqual((await getRoles(c, cookie, id)).json, { employeeId: 41, planningRoleIds: [], defaultPlanningRoleId: null })

    c.odoo.wire.length = 0
    const changed = await putRoles(c, cookie, id, { planningRoleIds: [4, 3] })
    assert.equal(changed.status, 200)
    assert.deepEqual(changed.json, { employeeId: 41, planningRoles: 2, asked: 2 })
    assert.deepEqual(c.odoo.wire.map((entry) => entry.path), [
      '/json/2/hr.employee/search_read', '/json/2/planning.role/search_read', '/json/2/hr.employee/write', '/json/2/hr.employee/search_read',
    ])
    const [write] = writes(c)
    assert.deepEqual(write.body.ids, [41])
    assert.deepEqual(write.body.vals, { planning_role_ids: [[6, 0, [4, 3]]], default_planning_role_id: 4 })
    assert.deepEqual(c.odoo.employees.map((employee) => [employee.planning_role_ids, employee.default_planning_role_id]), [[[4, 3], 4]])
    assert.deepEqual((await getRoles(c, cookie, id)).json, { employeeId: 41, planningRoleIds: [4, 3], defaultPlanningRoleId: 4 })
    // Nothing else of the employee, no user, no other model.
    for (const entry of c.odoo.wire) assert.ok(!/res\.users\/(create|write|unlink)|planning\.slot|\/create$|\/unlink$/.test(entry.path), entry.path)

    const cleared = await putRoles(c, cookie, id, { planningRoleIds: [] })
    assert.equal(cleared.status, 200)
    assert.deepEqual(c.odoo.employees.map((employee) => [employee.planning_role_ids, employee.default_planning_role_id]), [[[], false]], 'no roles: both emptied')
  })
})

test('chain: only the employee behind the account can be changed, whatever the browser sends', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const id = await technician(c, cookie)
    c.api.accounts.create({ username: 'andere', name: 'Anders', role: 'monteur', personId: 'user:5', password: 'een-goed-wachtwoord' })
    const other = c.api.accounts.list().find((account) => account.username === 'andere')?.id as string
    c.odoo.wire.length = 0
    for (const body of [{ planningRoleIds: [3], employeeId: 99 }, { planningRoleIds: [3], personId: 'employee:99' }, { planningRoleIds: [3], vals: { active: false } }]) {
      assert.equal((await putRoles(c, cookie, id, body)).status, 400, JSON.stringify(body))
    }
    assert.equal((await putRoles(c, cookie, other, { planningRoleIds: [3] })).status, 400, 'an account that is not an Odoo employee')
    assert.equal(c.odoo.wire.length, 0, 'nothing went to Odoo')
    assert.deepEqual(c.odoo.employees.map((employee) => employee.planning_role_ids), [[]])
  })
})

test('chain: a role that is gone, an employee that is gone, or a refusal by Odoo: an error and no change', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const id = await technician(c, cookie)
    c.odoo.mode.roles = [3]
    const roleGone = await putRoles(c, cookie, id, { planningRoleIds: [3, 4] })
    assert.equal(roleGone.status, 502)
    assert.match(String(roleGone.json.error), /planningsrol/i)
    assert.equal(writes(c).length, 0)
    c.odoo.mode.roles = [3, 4]

    c.odoo.employees[0].active = false
    const gone = await putRoles(c, cookie, id, { planningRoleIds: [3] })
    assert.equal(gone.status, 404)
    assert.equal(writes(c).length, 0)
    c.odoo.employees[0].active = true

    c.odoo.mode.write = 'refuse'
    const refused = await putRoles(c, cookie, id, { planningRoleIds: [3] })
    assert.equal(refused.status, 502)
    assert.match(String(refused.json.error), /geweigerd/)
    assert.deepEqual(c.odoo.employees.map((employee) => employee.planning_role_ids), [[]])
  })
})

test('chain: Odoo changed the roles but the answer was lost: the error says so, and repeating sets the same roles without harm', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const id = await technician(c, cookie)
    c.odoo.mode.write = 'lost'
    const lost = await putRoles(c, cookie, id, { planningRoleIds: [3, 4] })
    assert.equal(lost.status, 502)
    assert.match(String(lost.json.error), /opnieuw/)
    assert.deepEqual(c.odoo.employees.map((employee) => employee.planning_role_ids), [[3, 4]], 'Odoo did change them')
    c.odoo.mode.write = 'ok'
    assert.equal((await putRoles(c, cookie, id, { planningRoleIds: [3, 4] })).status, 200)
    assert.equal(c.odoo.employees.length, 1)
    assert.deepEqual(c.odoo.employees.map((employee) => employee.planning_role_ids), [[3, 4]])
  })
})

test('chain: with the action off in the gateway the planner is told, and Odoo is not touched', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const id = await technician(c, cookie)
    c.odoo.wire.length = 0
    const read1 = await getRoles(c, cookie, id)
    assert.equal(read1.status, 502)
    assert.match(String(read1.json.error), /niet aan/)
    assert.equal((await putRoles(c, cookie, id, { planningRoleIds: [3] })).status, 502)
    assert.equal(c.odoo.wire.length, 0)
  }, { rolesActionOff: true })
})

test('chain: a technician and a visitor cannot read or change roles, and neither the gateway nor Odoo is asked', async () => {
  await withChain(async (c) => {
    const cookie = await planner(c)
    const id = await technician(c, cookie)
    c.odoo.wire.length = 0
    const monteur = (await login(c.api, 'jan')).cookie
    for (const who of [monteur, undefined]) {
      const expected = who ? 403 : 401
      assert.equal((await getRoles(c, who, id)).status, expected)
      assert.equal((await putRoles(c, who, id, { planningRoleIds: [3] })).status, expected)
    }
    assert.equal(c.odoo.wire.length, 0)
  })
})
