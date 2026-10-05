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
