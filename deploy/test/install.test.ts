import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseProjects as parseGateway } from '../../gateway/src/projects.ts'
import { apply, check, remove, status } from '../install/cli.ts'
import { CADDY_FILE, PATHS } from '../install/templates.ts'
import { fakeServer, ORIGINAL_CADDYFILE, scriptedPrompts, type Server } from './fake-sys.ts'

const repo = (file: string) => readFileSync(path.join(import.meta.dirname, '../..', file), 'utf8')
const REPO_FILES = {
  'gateway/projects.example.json': repo('gateway/projects.example.json'),
  'deploy/dig-preview.service': repo('deploy/dig-preview.service'),
  'deploy/dig-builder-app.service': repo('deploy/dig-builder-app.service'),
}
const PASSWORD = 'een-lang-wachtwoord-123'
const ODOO_KEY = 'odookey0123456789abcdef'
const CLAUDE_KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOP_qrstuvwxyz-0123456789'

/** The answers of a first installation, in the order the installer asks. */
const FIRST_RUN = ['', '', '', ODOO_KEY, CLAUDE_KEY, PASSWORD, PASSWORD]

function server(options: Parameters<typeof fakeServer>[0] = {}) {
  return fakeServer({ repoFiles: REPO_FILES, ...options })
}

async function install(s: Server, answers: Array<string | boolean> = FIRST_RUN) {
  const script = scriptedPrompts(answers)
  const code = await apply({ sys: s.sys, prompts: script.prompts }, { yes: true })
  return { code, ...script }
}

const mutating = (calls: Server['calls']) =>
  calls.filter(({ cmd, args }) => {
    if (['useradd', 'usermod', 'chown', 'userdel'].includes(cmd) || (cmd === 'git' && args[0] === 'clone')) return true
    if (cmd === 'systemctl') return !['cat', 'is-active'].includes(args[0])
    if (cmd === 'docker') return !['info', 'ps', 'image', 'compose-version'].includes(args[0]) && !(args[0] === 'compose' && args[1] === 'version') && !(args[0] === 'network' && args[1] === 'inspect')
    return false
  })

test('check only looks: it reports the situation and changes nothing', async () => {
  const s = server()
  const script = scriptedPrompts([])
  const code = await check({ sys: s.sys, prompts: script.prompts })
  assert.equal(code, 0)
  const report = script.said.join('\n')
  assert.match(report, /Ubuntu 24\.04/)
  assert.match(report, /\/usr\/bin\/caddy, configuratie \/etc\/caddy\/Caddyfile/)
  assert.match(report, /Er is niets veranderd/)
  assert.deepEqual(s.writes, [])
  assert.deepEqual(s.removed, [])
  assert.deepEqual(mutating(s.calls), [])
})

test('check and apply refuse, with a reason, when the server cannot take the installation', async () => {
  for (const [options, reason] of [
    [{ isRoot: false }, /als root/],
    [{ noCaddy: true }, /Er draait geen Caddy/],
    [{ noDocker: true }, /Docker is niet geïnstalleerd/],
  ] as const) {
    const s = server(options)
    const checkScript = scriptedPrompts([])
    assert.equal(await check({ sys: s.sys, prompts: checkScript.prompts }), 1)
    assert.match(checkScript.said.join('\n'), reason)
    const applyScript = scriptedPrompts([])
    assert.equal(await apply({ sys: s.sys, prompts: applyScript.prompts }, { yes: true }), 1)
    assert.deepEqual(s.writes, [], 'nothing is written when the installation cannot start')
    assert.deepEqual(mutating(s.calls), [])
  }
})

test('a first installation does every step, writes the right files with the right modes, and leaves other containers alone', async () => {
  const s = server()
  const run = await install(s)
  assert.equal(run.code, 0, run.said.join('\n'))
  assert.equal(run.left(), 0, 'all answers were used')

  // users, code, image, network, gateway, services
  assert.ok(s.users.has('dig-builder'))
  assert.ok(s.calls.some((c) => c.cmd === 'git' && c.args[0] === 'clone' && c.args.at(-1) === PATHS.app && c.user === 'dig-builder'), 'the code is fetched as the service user, not as root')
  assert.ok(s.calls.some((c) => c.cmd === 'git' && c.args.at(-1) === `${PATHS.apps}/dashboard`))
  assert.ok(s.images.has('dig-sandbox:1'))
  assert.deepEqual(s.networks.get('dig-preview'), { internal: true })
  assert.ok(s.containers.has('dig-platform-odoo-gateway-1'))
  assert.deepEqual([...s.enabled].sort(), ['dig-builder-app', 'dig-preview'])
  assert.deepEqual([...s.active].sort(), ['dig-builder-app', 'dig-preview'])
  assert.ok(s.dirs.has(`${PATHS.apps}/dashboard/node_modules`), 'dependencies are installed so the preview can start')

  // Secrets: root only; files a service reads itself: group readable, not world readable.
  const mode = (file: string) => s.writes.filter((w) => w.file === file).at(-1)?.mode
  for (const file of ['stack.env', 'preview.env', 'builder-app.env', 'install.json']) assert.equal(mode(`${PATHS.etc}/${file}`), 0o600, file)
  assert.equal(mode(`${PATHS.etc}/previews.json`), 0o640)
  assert.equal(mode(`${PATHS.etc}/builder-projects.json`), 0o640)

  // Where each secret ends up, and where it must not.
  const everything = [...s.files].filter(([file]) => file.startsWith(PATHS.etc))
  const has = (value: string) => everything.filter(([, f]) => f.content.includes(value)).map(([file]) => path.basename(file)).sort()
  assert.deepEqual(has(ODOO_KEY), ['install.json', 'stack.env'])
  assert.deepEqual(has(CLAUDE_KEY), ['builder-app.env', 'install.json'])
  assert.deepEqual(has(PASSWORD), [], 'the password itself is stored nowhere, only its hash')
  const state = JSON.parse(s.text(`${PATHS.etc}/install.json`)!)
  assert.deepEqual(has(state.devToken), ['builder-app.env', 'install.json', 'previews.json'])
  assert.deepEqual(has(state.liveToken), ['builder-app.env', 'install.json'], 'the published app token is not given to the previews')
  assert.deepEqual(has(state.passwordHash), ['builder-app.env', 'install.json', 'preview.env'])
  assert.ok(!run.said.join('\n').includes(PASSWORD) && !run.said.join('\n').includes(ODOO_KEY) && !run.said.join('\n').includes(CLAUDE_KEY), 'nothing secret is printed')

  // The gateway accepts what was generated: two projects, hashes only.
  const gateway = parseGateway(JSON.parse(s.text(`${PATHS.etc}/gateway-projects.json`)!))
  assert.deepEqual(gateway.map((p) => p.id), ['monteursdashboard', 'monteursdashboard-live'])
  assert.ok(!s.text(`${PATHS.etc}/gateway-projects.json`)!.includes(state.devToken))

  // Only our own things were started or removed; the Odoo containers were never mentioned.
  const named = JSON.stringify(s.calls.map((c) => c.args))
  for (const other of ['odoo20-test', 'dig-builder-test']) assert.ok(!named.includes(other), other)
  assert.deepEqual([...s.containers.keys()].sort(), ['dig-builder-test-builder-1', 'dig-platform-odoo-gateway-1', 'odoo20-test-db-1', 'odoo20-test-odoo-1'])
})

test('the web server: one import line, a separate file, a backup, a validation, and a graceful reload', async () => {
  const s = server()
  assert.equal((await install(s)).code, 0)
  const main = s.text('/etc/caddy/Caddyfile')!
  assert.ok(main.startsWith(ORIGINAL_CADDYFILE.trimEnd()), 'the existing configuration is unchanged, only added to')
  assert.equal([...main.matchAll(/^import /gm)].length, 1)
  assert.match(main, new RegExp(`import ${CADDY_FILE}`))
  const snippet = s.text(CADDY_FILE)!
  assert.match(snippet, /bouwen\.srv1938209\.hstgr\.cloud \{[^}]*reverse_proxy 172\.17\.0\.1:8100/s)
  assert.match(snippet, /dashboard\.apps\.srv1938209\.hstgr\.cloud, dashboard-live\.apps\.srv1938209\.hstgr\.cloud \{[^}]*reverse_proxy 172\.17\.0\.1:8090/s)
  assert.ok(!snippet.includes('on_demand') && !snippet.includes('*.'), 'no wildcard or on-demand certificates')
  const backups = [...s.files].filter(([file]) => file.includes('Caddyfile.dig-backup-'))
  assert.equal(backups.length, 1)
  assert.equal(backups[0][1].content, ORIGINAL_CADDYFILE)
  assert.equal(s.validations, 1)
  assert.equal(s.reloads, 1)
  assert.ok(!s.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'restart' && c.args[1] === 'caddy'), 'reload, never restart')
  assert.equal(s.odooCalls, 2, 'the Odoo site was checked before and after')
})

test('running it again changes nothing that is already right and keeps the secrets', async () => {
  const s = server()
  await install(s)
  const state = s.text(`${PATHS.etc}/install.json`)!
  const callsBefore = s.calls.length
  const second = await install(s, [])
  assert.equal(second.code, 0, second.said.join('\n'))
  assert.equal(s.text(`${PATHS.etc}/install.json`), state, 'tokens, hash and secrets are kept')
  const again = s.calls.slice(callsBefore)
  assert.ok(!again.some((c) => c.cmd === 'useradd'))
  assert.ok(!again.some((c) => c.cmd === 'git' && c.args[0] === 'clone'), 'nothing is cloned twice')
  assert.ok(!again.some((c) => c.cmd === 'docker' && (c.args[0] === 'build' || (c.args[0] === 'network' && c.args[1] === 'create'))))
  assert.ok(!again.some((c) => c.cmd === 'node' && c.args.includes('install')), 'dependencies are not reinstalled')
  assert.ok(again.some((c) => c.cmd === 'git' && c.args.includes('merge')), 'the code is brought up to date')
  assert.equal(s.reloads, 1, 'Caddy is not reloaded when its configuration is already right')
  assert.equal([...s.text('/etc/caddy/Caddyfile')!.matchAll(/^import /gm)].length, 1)
  assert.ok(second.said.join('\n').includes('Caddy was al ingesteld'))
})

test('if the web server file of ours is changed or removed, running again repairs it without a second import line', async () => {
  const s = server()
  await install(s)
  const snippet = s.text(CADDY_FILE)!
  await s.sys.write(CADDY_FILE, '# door iemand aangepast\n')
  assert.equal((await install(s, [])).code, 0)
  assert.equal(s.text(CADDY_FILE), snippet, 'our file is written again')
  assert.equal([...s.text('/etc/caddy/Caddyfile')!.matchAll(/^import /gm)].length, 1)
  await s.sys.remove(CADDY_FILE)
  assert.equal((await install(s, [])).code, 0)
  assert.equal(s.text(CADDY_FILE), snippet)
  assert.equal([...s.text('/etc/caddy/Caddyfile')!.matchAll(/^import /gm)].length, 1)
})

test('without Odoo or Claude keys the rest is installed and the gateway waits; adding the key later starts it', async () => {
  const s = server()
  const first = await install(s, ['', '', '', '', '', PASSWORD, PASSWORD])
  assert.equal(first.code, 0, first.said.join('\n'))
  assert.ok(!s.containers.has('dig-platform-odoo-gateway-1'))
  assert.match(first.said.join('\n'), /geen Odoo-sleutel|nog geen Odoo-sleutel/)
  assert.match(first.said.join('\n'), /nog geen Claude-sleutel/)
  assert.ok(!s.text(`${PATHS.etc}/builder-app.env`)!.includes('ANTHROPIC_API_KEY'))

  const later = await install(s, [ODOO_KEY, CLAUDE_KEY])
  assert.equal(later.code, 0, later.said.join('\n'))
  assert.ok(s.containers.has('dig-platform-odoo-gateway-1'))
  assert.ok(s.text(`${PATHS.etc}/builder-app.env`)!.includes(`ANTHROPIC_API_KEY=${CLAUDE_KEY}`))
})

test('input is checked: an Odoo.sh address, a short or mismatching password, and a key with strange characters', async () => {
  const s = server()
  const run = await install(s, ['https://mijn.odoo.sh', '', '', '', 'sleutel met spatie', 'goede-sleutel-1', '', 'kort', 'een-lang-wachtwoord-123', 'anders-dan-hierboven', PASSWORD, PASSWORD])
  assert.equal(run.code, 0, run.said.join('\n'))
  const said = run.said.join('\n')
  assert.match(said, /productie-Odoo wordt nooit gekoppeld/)
  assert.match(said, /niet veilig kunnen worden opgeslagen/)
  assert.match(said, /Te kort/)
  assert.match(said, /niet gelijk/)
  assert.equal(JSON.parse(s.text(`${PATHS.etc}/install.json`)!).odooUrl, 'https://odoo20.srv1938209.hstgr.cloud')
})

test('if Caddy rejects the new configuration everything is put back and the Odoo site is untouched', async () => {
  const s = server({ caddyValidates: () => false })
  const run = await install(s)
  assert.equal(run.code, 1)
  assert.match(run.said.join('\n'), /Caddy keurt de nieuwe configuratie af; alles is teruggezet/)
  assert.equal(s.text('/etc/caddy/Caddyfile'), ORIGINAL_CADDYFILE)
  assert.equal(s.text(CADDY_FILE), null)
  assert.equal(s.reloads, 1, 'only the reload that puts the old configuration back')
})

test('if Caddy cannot reload, or the Odoo site answers differently afterwards, everything is put back', async () => {
  const failing = server({ caddyReloads: (() => { let n = 0; return () => ++n > 1 })() })
  const first = await install(failing)
  assert.equal(first.code, 1)
  assert.match(first.said.join('\n'), /Caddy kon niet herladen; alles is teruggezet/)
  assert.equal(failing.text('/etc/caddy/Caddyfile'), ORIGINAL_CADDYFILE)

  const statuses = [200, 502]
  const broken = server({ odooStatus: () => statuses.shift() ?? 502 })
  const second = await install(broken)
  assert.equal(second.code, 1)
  assert.match(second.said.join('\n'), /Odoo-testserver antwoordde vóór de wijziging met 200 en erna met 502; alles is teruggezet/)
  assert.equal(broken.text('/etc/caddy/Caddyfile'), ORIGINAL_CADDYFILE)
  assert.equal(broken.text(CADDY_FILE), null)
})

test('a service that does not start stops the installation and shows why', async () => {
  const s = server()
  const original = s.sys.run
  s.sys.run = async (cmd, args, options) => (cmd === 'systemctl' && args[0] === 'restart' && args[1] === 'dig-builder-app' ? { code: 0, stdout: '', stderr: '' } : original(cmd, args, options))
  const run = await install(s)
  assert.equal(run.code, 1)
  assert.match(run.said.join('\n'), /dig-builder-app draait niet/)
  assert.match(run.said.join('\n'), /boom/, 'the log of the service is shown')
  assert.equal(s.text('/etc/caddy/Caddyfile'), ORIGINAL_CADDYFILE, 'the web server is only touched once the services run')
})

test('an existing Docker network of that name that is not internal is not touched', async () => {
  const s = server()
  s.networks.set('dig-preview', { internal: false })
  const run = await install(s)
  assert.equal(run.code, 1)
  assert.match(run.said.join('\n'), /niet intern/)
  assert.ok(!s.calls.some((c) => c.cmd === 'docker' && c.args[0] === 'network' && ['rm', 'create'].includes(c.args[1])))
})

test('status reports services and addresses; before an installation it says so', async () => {
  const s = server()
  const empty = scriptedPrompts([])
  assert.equal(await status({ sys: s.sys, prompts: empty.prompts }), 1)
  assert.match(empty.said.join('\n'), /nog niets geïnstalleerd/)
  await install(s)
  const script = scriptedPrompts([])
  assert.equal(await status({ sys: s.sys, prompts: script.prompts }), 0)
  const text = script.said.join('\n')
  assert.match(text, /dig-preview\s+active/)
  assert.match(text, /odoo-gateway\s+active/)
  assert.match(text, /https:\/\/bouwen\.srv1938209\.hstgr\.cloud/)
})

test('uninstall takes away only what the installer added, restoring the web server file exactly', async () => {
  const s = server()
  await install(s)
  s.containers.set('dig-live-dashboard-abc-1234567', { labels: ['dig.live=dashboard'] })
  s.containers.set('dig-preview-dashboard', { labels: ['dig.preview=dashboard'] })
  const script = scriptedPrompts([true])
  assert.equal(await remove({ sys: s.sys, prompts: script.prompts }, false), 0, script.said.join('\n'))

  assert.equal(s.text('/etc/caddy/Caddyfile')!.trim(), ORIGINAL_CADDYFILE.trim())
  assert.equal(s.text(CADDY_FILE), null)
  assert.deepEqual([...s.enabled], [])
  assert.deepEqual([...s.active], [])
  assert.deepEqual([...s.containers.keys()].sort(), ['dig-builder-test-builder-1', 'odoo20-test-db-1', 'odoo20-test-odoo-1'], 'only our own containers are gone')
  assert.ok(!s.networks.has('dig-preview'))
  assert.ok(s.files.has(`${PATHS.etc}/install.json`), 'without purge the code, data and secrets stay')
  assert.ok(s.users.has('dig-builder'))
  assert.ok(s.images.has('dig-sandbox:1'))

  const declined = scriptedPrompts([false])
  assert.equal(await remove({ sys: s.sys, prompts: declined.prompts }, true), 1)
})

test('uninstall purge also removes the code, data, secrets and the user', async () => {
  const s = server()
  await install(s)
  const script = scriptedPrompts([true])
  assert.equal(await remove({ sys: s.sys, prompts: script.prompts }, true), 0)
  assert.ok(!s.files.has(`${PATHS.etc}/install.json`))
  assert.ok(![...s.files.keys()].some((f) => f.startsWith(PATHS.root)))
  assert.ok(!s.users.has('dig-builder'))
  assert.ok(!s.images.has('dig-sandbox:1'))
})
