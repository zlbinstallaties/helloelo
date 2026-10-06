import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { allModels, findProject, parseProjects, sha256Hex } from '../src/projects.ts'

function config(overrides: Record<string, unknown> = {}, model: Record<string, unknown> = {}) {
  return {
    projects: [
      {
        id: 'app-one',
        tokenSha256: sha256Hex('token-one'),
        companyId: 2,
        models: { 'planning.slot': { fields: ['name'], methods: ['search_read'], ...model } },
        ...overrides,
      },
    ],
  }
}

test('example config parses and id is always allowed', () => {
  const projects = parseProjects(JSON.parse(readFileSync(new URL('../projects.example.json', import.meta.url), 'utf8')))
  assert.equal(projects[0].companyId, 2)
  assert.ok(projects[0].models['planning.slot'].fields.includes('id'))
  assert.deepEqual(allModels(projects).sort(), ['planning.slot', 'svs.tech.visit'])
})

test('write methods are refused at load time', () => {
  for (const method of ['write', 'create', 'unlink', 'execute_kw', 'read_group']) {
    assert.throws(() => parseProjects(config({}, { methods: [method] })), /not allowed/)
  }
})

test('invalid config is refused', () => {
  assert.throws(() => parseProjects(config({ companyId: 0 })), /companyId/)
  assert.throws(() => parseProjects(config({ tokenSha256: 'plain-token' })), /sha256/)
  assert.throws(() => parseProjects(config({ maxLimit: 5000 })), /maxLimit/)
  assert.throws(() => parseProjects(config({}, { fields: ['partner_id.name'] })), /invalid field/)
  assert.throws(() => parseProjects(config({}, { fields: [] })), /fields/)
  assert.throws(() => parseProjects(config({ models: { 'Bad Model': { fields: ['x'], methods: ['search_read'] } } })), /model/)
  const twice = config()
  twice.projects.push({ ...twice.projects[0], id: 'app-two' })
  assert.throws(() => parseProjects(twice), /shared/)
})

test('findProject matches only the right token', () => {
  const projects = parseProjects(config())
  assert.equal(findProject(projects, 'token-one')?.id, 'app-one')
  assert.equal(findProject(projects, 'token-two'), null)
  assert.equal(findProject(projects, ''), null)
})

// ---- actions: the one narrow write, off unless a project asks for it ----

test('without an actions block a project can do no action, and the example config has none', () => {
  const [project] = parseProjects(config())
  assert.deepEqual(project.actions, {})
  const example = parseProjects(JSON.parse(readFileSync(new URL('../projects.example.json', import.meta.url), 'utf8')))
  for (const item of example) assert.deepEqual(item.actions, {}, `${item.id} must not allow actions by default`)
})

test('createEmployee needs the Odoo user who is responsible, and has a default cap per hour', () => {
  const [project] = parseProjects(config({ actions: { createEmployee: { responsibleUserId: 9 } } }))
  assert.deepEqual(project.actions, { createEmployee: { responsibleUserId: 9, maxPerHour: 20, planningRoleIds: [], defaultPlanningRoleId: null } })
  const [capped] = parseProjects(config({ actions: { createEmployee: { responsibleUserId: 9, maxPerHour: 5 } } }))
  assert.equal(capped.actions.createEmployee?.maxPerHour, 5)
})

test('an invalid actions block is refused when the config is loaded', () => {
  const create = (value: unknown) => config({ actions: { createEmployee: value } })
  for (const value of [null, 'ja', [], {}, { responsibleUserId: 0 }, { responsibleUserId: -1 }, { responsibleUserId: 1.5 }, { responsibleUserId: '9' }]) {
    assert.throws(() => parseProjects(create(value)), /createEmployee/, JSON.stringify(value))
  }
  for (const maxPerHour of [0, -1, 201, 1.5, '5']) {
    assert.throws(() => parseProjects(create({ responsibleUserId: 9, maxPerHour })), /maxPerHour/, String(maxPerHour))
  }
  assert.throws(() => parseProjects(create({ responsibleUserId: 9, userId: 5 })), /unknown/)
  assert.throws(() => parseProjects(create({ responsibleUserId: 9, companyId: 3 })), /unknown/)
})

test('only known actions can be configured: no generic create, write or unlink', () => {
  for (const action of ['create', 'write', 'unlink', 'execute_kw', 'create_user', 'createUser']) {
    assert.throws(() => parseProjects(config({ actions: { [action]: { responsibleUserId: 9 } } })), /action/, action)
  }
  assert.throws(() => parseProjects(config({ actions: [] })), /actions/)
  assert.throws(() => parseProjects(config({ actions: 'ja' })), /actions/)
})

test('actions do not widen the models a project can read', () => {
  const projects = parseProjects(config({ actions: { createEmployee: { responsibleUserId: 9 } } }))
  assert.deepEqual(allModels(projects), ['planning.slot'])
  assert.equal(Object.hasOwn(projects[0].models, 'hr.employee'), false)
})

test('planning roles for new employees: a short list of different ids, and a default that is one of them', () => {
  const [project] = parseProjects(config({ actions: { createEmployee: { responsibleUserId: 9, planningRoleIds: [3, 4], defaultPlanningRoleId: 3 } } }))
  assert.deepEqual(project.actions.createEmployee?.planningRoleIds, [3, 4])
  assert.equal(project.actions.createEmployee?.defaultPlanningRoleId, 3)
  const [onlyRoles] = parseProjects(config({ actions: { createEmployee: { responsibleUserId: 9, planningRoleIds: [3] } } }))
  assert.equal(onlyRoles.actions.createEmployee?.defaultPlanningRoleId, null)
  const create = (settings: Record<string, unknown>) => config({ actions: { createEmployee: { responsibleUserId: 9, ...settings } } })
  for (const planningRoleIds of ['3', 3, [0], [-1], [1.5], ['3'], [3, 3], [1, 2, 3, 4, 5, 6], [null]]) {
    assert.throws(() => parseProjects(create({ planningRoleIds })), /planningRoleIds/, JSON.stringify(planningRoleIds))
  }
  for (const settings of [{ defaultPlanningRoleId: 3 }, { planningRoleIds: [3], defaultPlanningRoleId: 4 }, { planningRoleIds: [3], defaultPlanningRoleId: '3' }, { planningRoleIds: [3], defaultPlanningRoleId: 0 }]) {
    assert.throws(() => parseProjects(create(settings)), /defaultPlanningRoleId/, JSON.stringify(settings))
  }
})
