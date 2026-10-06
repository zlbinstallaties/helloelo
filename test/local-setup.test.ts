import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { parseProjects, sha256Hex } from '../gateway/src/projects.ts'
import { DEFAULTS, FILE_NAMES, buildLocalSetup, generateSecrets, resolveOptions, writeLocalSetup } from '../scripts/local-setup.ts'
import type { LocalSetupOptions } from '../scripts/local-setup.ts'
import { verifyPassword } from '../src/lib/password.ts'

const example = JSON.parse(readFileSync(new URL('../gateway/projects.example.json', import.meta.url), 'utf8')) as {
  projects: Array<{ models: unknown }>
}
const options: LocalSetupOptions = { ...DEFAULTS, database: 'dig-test', companyId: 2, responsibleId: 7 }

function build(overrides: Partial<LocalSetupOptions> = {}) {
  const secrets = generateSecrets()
  const files = buildLocalSetup({ ...options, ...overrides }, secrets, example)
  return { secrets, files, projects: JSON.parse(files['gateway-projects.json']) as { projects: Array<Record<string, any>> } }
}

test('the project file is valid for the gateway and holds the hash of the token the dashboard gets', () => {
  const { secrets, files, projects } = build()
  const parsed = parseProjects(projects)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].companyId, 2)
  assert.equal(projects.projects[0].tokenSha256, sha256Hex(secrets.gatewayToken))
  assert.equal(parseEnv(files['dashboard.env']).DIG_GATEWAY_TOKEN, secrets.gatewayToken)
  assert.deepEqual(projects.projects[0].models, example.projects[0].models, 'the allowlist is the one in projects.example.json')
  assert.ok(!files['gateway-projects.json'].includes(secrets.gatewayToken), 'only the hash is in the project file')
})

test('adding technicians in Odoo is on only when a responsible is given, and then only that one action', () => {
  assert.deepEqual(build().projects.projects[0].actions, { createEmployee: { responsibleUserId: 7 } })
  const off = build({ responsibleId: null })
  assert.equal('actions' in off.projects.projects[0], false)
  assert.equal(parseProjects(off.projects)[0].actions.createEmployee, undefined)
})

test('dashboard.env: login is on, the secret is long enough, the hash fits the printed password, no password on disk', () => {
  const { secrets, files } = build()
  const env = parseEnv(files['dashboard.env'])
  assert.equal(env.DIG_AUTH, undefined, 'never switches the login off')
  assert.ok(Buffer.byteLength(env.DIG_SESSION_SECRET ?? '') >= 32)
  assert.equal(env.DIG_ADMIN_USERNAME, 'admin')
  assert.equal(verifyPassword(secrets.adminPassword, env.DIG_ADMIN_PASSWORD_HASH), true)
  assert.equal(verifyPassword('niet-het-wachtwoord', env.DIG_ADMIN_PASSWORD_HASH), false)
  for (const name of FILE_NAMES) assert.ok(!files[name].includes(secrets.adminPassword), `${name} has no password`)
  assert.equal(env.DIG_SECURE_COOKIES, 'false', 'plain http on localhost')
  assert.equal(env.HOST, '127.0.0.1', 'only reachable from this computer')
  assert.equal(env.DIG_GATEWAY_URL, 'http://127.0.0.1:8070')
  assert.equal(env.DIG_DATA_DIR, '.local/data')
})

test('gateway.env: the API key is left empty for the user, the host list is only the Odoo host', () => {
  const { files } = build({ odooUrl: 'http://127.0.0.1:18069' })
  const env = parseEnv(files['gateway.env'])
  assert.equal(env.ODOO_API_KEY, '')
  assert.equal(env.ODOO_BASE_URL, 'http://127.0.0.1:18069')
  assert.equal(env.ODOO_ALLOWED_HOSTS, '127.0.0.1')
  assert.equal(env.ODOO_DATABASE, 'dig-test')
  assert.equal(env.GATEWAY_PROJECTS_FILE, '.local/gateway-projects.json')
  assert.equal('ODOO_DATABASE' in parseEnv(build({ database: '' }).files['gateway.env']), false, 'no database: Odoo picks the only one')
})

test('every run makes new secrets', () => {
  const first = generateSecrets()
  const second = generateSecrets()
  assert.notEqual(first.gatewayToken, second.gatewayToken)
  assert.notEqual(first.sessionSecret, second.sessionSecret)
  assert.notEqual(first.adminPassword, second.adminPassword)
})

test('the options refuse production, plain http elsewhere, odd values and a path', () => {
  assert.deepEqual(resolveOptions({}), DEFAULTS)
  assert.equal(resolveOptions({ 'odoo-url': 'http://localhost:8069/' }).odooUrl, 'http://localhost:8069')
  assert.equal(resolveOptions({ 'odoo-url': 'https://odoo-test.example.nl' }).odooUrl, 'https://odoo-test.example.nl')
  assert.throws(() => resolveOptions({ 'odoo-url': 'https://dig.odoo.com' }), /never allowed/)
  assert.throws(() => resolveOptions({ 'odoo-url': 'https://dig.dev.odoo.sh' }), /never allowed/)
  assert.throws(() => resolveOptions({ 'odoo-url': 'https://odoo.com' }), /never allowed/)
  assert.throws(() => resolveOptions({ 'odoo-url': 'http://10.0.0.5:8069' }), /https/)
  assert.throws(() => resolveOptions({ 'odoo-url': 'http://localhost:8069/odoo' }), /pad/)
  assert.throws(() => resolveOptions({ 'odoo-url': 'geen adres' }), /geldig/)
  for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3']) {
    assert.throws(() => resolveOptions({ 'company-id': bad }), /company-id/, bad)
    assert.throws(() => resolveOptions({ 'responsible-id': bad }), /responsible-id/, bad)
  }
  assert.throws(() => resolveOptions({ database: 'a b' }), /database/)
  assert.throws(() => resolveOptions({ database: 'x\nODOO_API_KEY=boos' }), /database/)
  assert.throws(() => resolveOptions({ 'admin-username': 'a#b' }), /admin-username/)
  assert.equal(resolveOptions({ 'responsible-id': '7', 'company-id': '2' }).responsibleId, 7)
})

test('writing: private files, nothing overwritten without --force, and then new secrets', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-setup-'))
  try {
    const first = build()
    const written = writeLocalSetup(root, '.local', first.files, false)
    assert.equal(written.length, 3)
    assert.equal(statSync(path.join(root, '.local')).mode & 0o777, 0o700)
    for (const file of written) assert.equal(statSync(file).mode & 0o777, 0o600, file)

    const second = build()
    assert.throws(() => writeLocalSetup(root, '.local', second.files, false), /bestaat al/)
    assert.equal(readFileSync(path.join(root, '.local', 'dashboard.env'), 'utf8'), first.files['dashboard.env'], 'untouched')

    writeFileSync(path.join(root, '.local', 'gateway.env'), 'ODOO_API_KEY=mijn-sleutel\n')
    writeLocalSetup(root, '.local', second.files, true)
    assert.equal(readFileSync(path.join(root, '.local', 'dashboard.env'), 'utf8'), second.files['dashboard.env'])
    assert.notEqual(second.files['dashboard.env'], first.files['dashboard.env'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a partly existing set is refused as a whole: nothing is written', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-setup-'))
  try {
    const { files } = build()
    writeFileSync(path.join(root, 'gateway.env'), 'ODOO_API_KEY=mijn-sleutel\n')
    assert.throws(() => writeLocalSetup(root, '.', files, false), /gateway\.env/)
    assert.equal(readFileSync(path.join(root, 'gateway.env'), 'utf8'), 'ODOO_API_KEY=mijn-sleutel\n')
    assert.throws(() => statSync(path.join(root, 'dashboard.env')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a planning role: set for every new employee, as the default too, and only together with a responsible', () => {
  const { projects } = build({ planningRoleId: 1 })
  assert.deepEqual(projects.projects[0].actions, { createEmployee: { responsibleUserId: 7, planningRoleIds: [1], defaultPlanningRoleId: 1 } })
  const parsed = parseProjects(projects)[0].actions.createEmployee
  assert.deepEqual(parsed?.planningRoleIds, [1])
  assert.equal(parsed?.defaultPlanningRoleId, 1)
  assert.deepEqual(build().projects.projects[0].actions, { createEmployee: { responsibleUserId: 7 } }, 'none unless asked for')
  assert.equal(resolveOptions({ 'responsible-id': '7', 'planning-role-id': '3' }).planningRoleId, 3)
  assert.equal(resolveOptions({}).planningRoleId, null)
  assert.throws(() => resolveOptions({ 'planning-role-id': '3' }), /responsible-id/)
  for (const bad of ['0', '-1', '1.5', 'x', '']) assert.throws(() => resolveOptions({ 'responsible-id': '7', 'planning-role-id': bad }), /planning-role-id/, bad)
  assert.equal('actions' in build({ responsibleId: null, planningRoleId: null }).projects.projects[0], false)
})
