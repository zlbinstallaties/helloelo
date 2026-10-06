import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSessions, hashPassword } from '../../sandbox/src/auth.ts'
import type { PublicationManager } from '../src/publish.ts'
import { createBuilderServer } from '../src/server.ts'
import { fakeExecute, setup, waitFor } from './helpers.ts'

const PASSWORD = 'bouw-wachtwoord-123'
const ASSETS = {
  'index.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>DIG Builder</title>' },
  'app.js': { type: 'text/javascript; charset=utf-8', body: 'console.log(1)' },
  'style.css': { type: 'text/css; charset=utf-8', body: 'body{}' },
}

async function start(execute = fakeExecute(), opts: { maxConcurrent?: number; publications?: (s: Awaited<ReturnType<typeof setup>>) => PublicationManager } = {}) {
  const s = await setup(execute, opts)
  const logs: Record<string, unknown>[] = []
  const handler = createBuilderServer({
    projects: s.projects, runs: s.runs, store: s.store, publications: opts.publications?.(s),
    passwordHash: hashPassword(PASSWORD), sessions: createSessions({ secret: 'k'.repeat(32) }),
    secureCookies: true, assets: ASSETS, log: (e) => logs.push(e),
  })
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let cookie = ''
  const api = async (path: string, init: { method?: string; body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {}) => {
    const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET')
    const headers: Record<string, string> = { ...init.headers }
    const use = init.cookie === undefined ? cookie : init.cookie
    if (use) headers.cookie = use
    if (method === 'POST' && !('x-dig-builder' in headers)) headers['x-dig-builder'] = '1'
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(base + path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
    const text = await response.text()
    let body: any = text
    try { body = JSON.parse(text) } catch { /* plain text */ }
    return { status: response.status, headers: response.headers, body }
  }
  const login = async () => {
    const r = await api('/api/login', { body: { password: PASSWORD }, cookie: null })
    cookie = String(r.headers.get('set-cookie')).split(';')[0]
    return r
  }
  return { ...s, base, api, login, logs, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

test('the UI is public, with a strict content security policy; unknown paths are 404', async () => {
  const t = await start()
  try {
    const page = await fetch(t.base + '/')
    assert.equal(page.status, 200)
    assert.match(String(page.headers.get('content-security-policy')), /script-src 'self'/)
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.match(await page.text(), /DIG Builder/)
    assert.equal((await fetch(t.base + '/app.js')).status, 200)
    for (const path of ['/nope', '/../etc/passwd', '/%2e%2e/secret', '/constructor', '/__proto__', '/toString']) {
      assert.equal((await fetch(t.base + path)).status, 404, path)
    }
    assert.equal((await fetch(t.base + '/', { method: 'PUT' })).status, 405)
  } finally {
    await t.close()
  }
})

test('login: wrong password refused, right one sets a strict cookie, protected routes need it', async () => {
  const t = await start()
  try {
    assert.equal((await t.api('/api/projects', { cookie: null })).status, 401)
    assert.equal((await t.api('/api/runs', { cookie: null })).status, 401)
    assert.deepEqual((await t.api('/api/session', { cookie: null })).body, { authenticated: false })
    const wrong = await t.api('/api/login', { body: { password: 'nee' }, cookie: null })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.headers.get('set-cookie'), null)
    const ok = await t.login()
    assert.equal(ok.status, 200)
    for (const part of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(String(ok.headers.get('set-cookie')).includes(part), part)
    assert.deepEqual((await t.api('/api/session')).body, { authenticated: true })
    assert.equal((await t.api('/api/projects')).status, 200)
    const out = await t.api('/api/logout', { method: 'POST', body: {} })
    assert.match(String(out.headers.get('set-cookie')), /Max-Age=0/)
    assert.ok(!JSON.stringify(t.logs).includes(PASSWORD), 'passwords are never logged')
  } finally {
    await t.close()
  }
})

test('repeated wrong passwords are blocked', async () => {
  const t = await start()
  try {
    for (let i = 0; i < 10; i++) await t.api('/api/login', { body: { password: 'nee' }, cookie: null })
    assert.equal((await t.api('/api/login', { body: { password: PASSWORD }, cookie: null })).status, 429)
  } finally {
    await t.close()
  }
})

test('changing calls need the header and a same-site origin', async () => {
  const t = await start()
  try {
    await t.login()
    const task = { task: 'Zet a op 2 in het dashboard' }
    assert.equal((await t.api('/api/projects/dashboard/runs', { body: task, headers: { 'x-dig-builder': '0' } })).status, 403)
    assert.equal((await t.api('/api/projects/dashboard/runs', { body: task, headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await t.api('/api/logout', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status, 403)
    const sameOrigin = await t.api('/api/projects/dashboard/runs', { body: task, headers: { origin: t.base } })
    assert.equal(sameOrigin.status, 201)
  } finally {
    await t.close()
  }
})

test('projects are listed without paths or tokens', async () => {
  const t = await start()
  try {
    await t.login()
    const { body } = await t.api('/api/projects')
    assert.deepEqual(Object.keys(body.projects[0]).sort(), ['baseBranch', 'id', 'name', 'previewUrl', 'publish', 'runningRunId', 'sandbox'])
    assert.ok(!JSON.stringify(body).includes(t.root))
  } finally {
    await t.close()
  }
})

test('start a run, follow it live, read the result and the diff, approve it', async () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const t = await start(fakeExecute({ gate }))
  try {
    await t.login()
    const created = await t.api('/api/projects/dashboard/runs', { body: { task: 'Zet a op 2 in het dashboard', effort: 'medium', maxCostUsd: 3 } })
    assert.equal(created.status, 201)
    const id = created.body.id
    assert.deepEqual([created.body.state, created.body.effort, created.body.maxCostUsd], ['running', 'medium', 3])

    const unauth = await fetch(`${t.base}/api/runs/${id}/events`)
    assert.equal(unauth.status, 401)

    const live = await fetch(`${t.base}/api/runs/${id}/events`, { headers: { cookie: (await loginCookie(t)) } })
    assert.equal(live.status, 200)
    assert.match(String(live.headers.get('content-type')), /text\/event-stream/)
    const reader = live.body!.getReader()
    let received = ''
    const pump = (async () => {
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        received += decoder.decode(value)
      }
    })()
    await waitFor(() => received.includes('"phase":"agent"'), 'first events over SSE')
    open()
    await pump
    assert.match(received, /event: run\ndata: .*"name":"write_file"/)
    assert.match(received, /event: end\ndata: \{"state":"finished","status":"done"\}/)

    const run = (await t.api(`/api/runs/${id}`)).body
    assert.deepEqual([run.state, run.status, run.running, run.decision], ['finished', 'done', false, null])
    assert.match(run.summary, /\*\*a\*\*/)
    const diff = await t.api(`/api/runs/${id}/diff`)
    assert.match(String(diff.headers.get('content-type')), /text\/plain/)
    assert.match(diff.body, /\+export const a = 2/)
    const list = (await t.api('/api/runs?project=dashboard')).body.runs
    assert.equal(list.length, 1)
    assert.ok(!('summary' in list[0]) && !('stat' in list[0]), 'the list stays small')

    const approved = await t.api(`/api/runs/${id}/approve`, { method: 'POST', body: {} })
    assert.deepEqual([approved.status, approved.body.decision], [200, 'approved'])
    assert.equal((await t.api(`/api/runs/${id}/approve`, { method: 'POST', body: {} })).status, 409)
    assert.equal((await t.api('/api/projects')).body.projects[0].runningRunId, null)
  } finally {
    await t.close()
  }
})

async function loginCookie(t: { api: (p: string, i?: any) => Promise<any> }) {
  const r = await t.api('/api/login', { body: { password: PASSWORD }, cookie: null })
  return String(r.headers.get('set-cookie')).split(';')[0]
}

test('a finished run replays its events and ends; bad ids are 404', async () => {
  const t = await start()
  try {
    await t.login()
    const id = (await t.api('/api/projects/dashboard/runs', { body: { task: 'Zet a op 2 in het dashboard' } })).body.id
    await waitFor(async () => (await t.api(`/api/runs/${id}`)).body.state === 'finished', 'finished')
    const replay = await fetch(`${t.base}/api/runs/${id}/events`, { headers: { cookie: await loginCookie(t) } })
    const text = await replay.text()
    assert.match(text, /event: run\ndata: .*"phase":"branch"/)
    assert.match(text, /event: end\ndata: \{"finished":true\}/)
    for (const bad of ['/api/runs/nope', '/api/runs/..%2f..%2fetc', `/api/runs/${id}x/diff`, '/api/runs/2026-10-05-ffffff']) {
      assert.equal((await t.api(bad)).status, 404, bad)
    }
  } finally {
    await t.close()
  }
})

test('stop, reject, validation errors and body limits are reported properly', async () => {
  const t = await start(fakeExecute({ untilAborted: true }))
  try {
    await t.login()
    assert.equal((await t.api('/api/projects/dashboard/runs', { body: { task: 'kort' } })).status, 400)
    assert.equal((await t.api('/api/projects/dashboard/runs', { body: { task: 'x'.repeat(20_000) } })).status, 413)
    const broken = await fetch(`${t.base}/api/projects/dashboard/runs`, { method: 'POST', headers: { cookie: await loginCookie(t), 'x-dig-builder': '1', 'content-type': 'application/json' }, body: '{nope' })
    assert.equal(broken.status, 400)
    assert.equal((await t.api('/api/projects/nope/runs', { body: { task: 'Zet a op 2 in het dashboard' } })).status, 404)
    const id = (await t.api('/api/projects/dashboard/runs', { body: { task: 'Zet a op 2 in het dashboard' } })).body.id
    assert.equal((await t.api('/api/projects/dashboard/runs', { body: { task: 'Nog een opdracht erbij' } })).status, 409)
    assert.equal((await t.api(`/api/runs/${id}/reject`, { method: 'POST', body: {} })).status, 409)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await t.api(`/api/runs/${id}/stop`, { method: 'POST', body: {} })).status, 202)
    await waitFor(async () => (await t.api(`/api/runs/${id}`)).body.status === 'stopped', 'stopped')
    const rejected = await t.api(`/api/runs/${id}/reject`, { method: 'POST', body: {} })
    assert.deepEqual([rejected.status, rejected.body.decision], [200, 'rejected'])
    assert.equal((await t.api(`/api/runs/${id}/stop`, { method: 'POST', body: {} })).status, 409)
  } finally {
    await t.close()
  }
})

/** A stand-in for the publication manager that records what the server asked of it. */
function fakePublications() {
  const calls: string[] = []
  const status = { enabled: true, url: 'https://dashboard-live.example.nl', current: null, releases: [], baseCommit: 'a'.repeat(40), upToDate: null, job: null }
  const manager = {
    isEnabled: () => true,
    status: async () => status,
    publish: async (id: string) => { calls.push(`publish ${id}`); return { ...status, job: { kind: 'publish', state: 'running' } } },
    rollback: async (id: string, releaseId?: string) => { calls.push(`rollback ${id} ${releaseId ?? ''}`); return status },
    restart: async (id: string) => { calls.push(`restart ${id}`); return status },
  } as unknown as PublicationManager
  return { manager, calls }
}

test('publication: needs a session, a CSRF header and a known project; reports "disabled" when not configured', async () => {
  const t = await start()
  try {
    assert.equal((await t.api('/api/projects/dashboard/publication')).status, 401)
    await t.login()
    const off = await t.api('/api/projects/dashboard/publication')
    assert.equal(off.status, 200)
    assert.equal(off.body.enabled, false)
    assert.equal((await t.api('/api/projects/dashboard/publication/publish', { method: 'POST', body: {} })).status, 409)
    assert.equal((await t.api('/api/projects/nope/publication')).status, 404)
    assert.equal((await t.api('/api/projects/nope/publication/publish', { method: 'POST', body: {} })).status, 404)
  } finally {
    await t.close()
  }
})

test('publication: publish, rollback and restart are passed on, with the release id checked', async () => {
  const fake = fakePublications()
  const t = await start(fakeExecute(), { publications: () => fake.manager })
  try {
    await t.login()
    const status = await t.api('/api/projects/dashboard/publication')
    assert.equal(status.status, 200)
    assert.equal(status.body.url, 'https://dashboard-live.example.nl')

    const noHeader = await t.api('/api/projects/dashboard/publication/publish', { method: 'POST', body: {}, headers: { 'x-dig-builder': '' } })
    assert.equal(noHeader.status, 403)
    const crossSite = await t.api('/api/projects/dashboard/publication/publish', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })
    assert.equal(crossSite.status, 403)
    assert.deepEqual(fake.calls, [])

    const published = await t.api('/api/projects/dashboard/publication/publish', { method: 'POST', body: {} })
    assert.equal(published.status, 202)
    assert.equal(published.body.job.state, 'running')
    assert.equal((await t.api('/api/projects/dashboard/publication/restart', { method: 'POST', body: {} })).status, 202)
    assert.equal((await t.api('/api/projects/dashboard/publication/rollback', { method: 'POST', body: {} })).status, 202)
    assert.equal((await t.api('/api/projects/dashboard/publication/rollback', { method: 'POST', body: { releaseId: 'abc123-0123abc' } })).status, 202)
    for (const releaseId of ['../../x', 'ABC-0123abc', 5, 'abc123-0123abc; rm -rf /']) {
      assert.equal((await t.api('/api/projects/dashboard/publication/rollback', { method: 'POST', body: { releaseId } })).status, 400, String(releaseId))
    }
    assert.equal((await t.api('/api/projects/dashboard/publication/explode', { method: 'POST', body: {} })).status, 404)
    assert.deepEqual(fake.calls, ['publish dashboard', 'restart dashboard', 'rollback dashboard ', 'rollback dashboard abc123-0123abc'])
  } finally {
    await t.close()
  }
})

test('the project list tells the screen where the live app is, without any token or path', async () => {
  const fake = fakePublications()
  const t = await start(fakeExecute(), { publications: () => fake.manager })
  try {
    t.projects[0].publish = {
      config: { build: ['b'], start: ['s'], port: 3000, healthPath: '/', env: { DIG_GATEWAY_TOKEN: 'tok-secret' } },
      url: 'https://dashboard-live.example.nl',
    }
    await t.login()
    const list = await t.api('/api/projects')
    assert.deepEqual(list.body.projects[0].publish, { url: 'https://dashboard-live.example.nl' })
    const text = JSON.stringify(list.body)
    assert.ok(!text.includes('tok-secret') && !text.includes(t.root))
  } finally {
    await t.close()
  }
})
