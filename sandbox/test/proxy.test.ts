import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { createSessions, hashPassword } from '../src/auth.ts'
import type { PreviewProject, PreviewState } from '../src/preview.ts'
import { createPreviewProxy } from '../src/proxy.ts'

const PASSWORD = 'preview-wachtwoord-123'
const HASH = hashPassword(PASSWORD)

const sockets = new Set<import('node:net').Socket>()

async function listen(server: Server) {
  // Upgraded sockets are no longer tracked by the http server; track them here.
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

/** Upstream that echoes what it received, and answers WebSocket-style upgrades. */
async function upstream() {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'app=1' })
    res.end(`hello from ${req.url}`)
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url!, headers: req.headers })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(`echo:${d}`))
  })
  const port = await listen(server)
  return { server, port, seen }
}

async function setup(state: () => PreviewState | Promise<PreviewState>) {
  const up = await upstream()
  const ensured: string[] = []
  const projects = new Map<string, PreviewProject>([['dashboard', { id: 'dashboard', workdir: '/x' }]])
  const proxy = createPreviewProxy({
    domain: 'preview.test',
    passwordHash: HASH,
    sessions: createSessions({ secret: 's'.repeat(32) }),
    previews: {
      async ensure(project) {
        ensured.push(project.id)
        return state()
      },
    },
    projects,
    secureCookies: true,
    log: () => {},
  })
  const server = createServer(proxy.handleRequest)
  server.on('upgrade', proxy.handleUpgrade)
  const port = await listen(server)
  return {
    up,
    ensured,
    port,
    target: `http://127.0.0.1:${up.port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((r) => server.close(r))
      await new Promise((r) => up.server.close(r))
    },
  }
}

function call(port: number, path: string, opts: { method?: string; host?: string; cookie?: string; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          host: opts.host ?? 'dashboard.preview.test',
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(opts.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

async function loginCookie(port: number) {
  const res = await call(port, '/_dig/login', { method: 'POST', body: `password=${PASSWORD}&next=%2Fapp` })
  assert.equal(res.status, 303)
  return String(res.headers['set-cookie']).split(';')[0]
}

test('not logged in: redirect to login, nothing started', async () => {
  const env = await setup(() => ({ state: 'starting' }))
  try {
    const res = await call(env.port, '/app?x=1')
    assert.equal(res.status, 302)
    assert.equal(res.headers.location, '/_dig/login?next=%2Fapp%3Fx%3D1')
    assert.equal((await call(env.port, '/api', { method: 'POST' })).status, 401)
    assert.deepEqual(env.ensured, [])
    const form = await call(env.port, '/_dig/login?next=%2Fapp')
    assert.match(form.body, /name="next" value="\/app"/)
    assert.match(String(form.headers['content-security-policy']), /default-src 'none'/)
  } finally {
    await env.close()
  }
})

test('login: wrong password refused, right password sets a scoped secure cookie', async () => {
  const env = await setup(() => ({ state: 'starting' }))
  try {
    const wrong = await call(env.port, '/_dig/login', { method: 'POST', body: 'password=nope&next=%2F' })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.headers['set-cookie'], undefined)
    const ok = await call(env.port, '/_dig/login', { method: 'POST', body: `password=${PASSWORD}&next=%2Fapp` })
    assert.equal(ok.status, 303)
    assert.equal(ok.headers.location, '/app')
    const cookie = String(ok.headers['set-cookie'])
    for (const part of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Domain=preview.test', 'Path=/']) assert.ok(cookie.includes(part), part)
  } finally {
    await env.close()
  }
})

test('open redirects via next are blocked', async () => {
  const env = await setup(() => ({ state: 'starting' }))
  try {
    for (const next of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const res = await call(env.port, '/_dig/login', { method: 'POST', body: `password=${PASSWORD}&next=${encodeURIComponent(next)}` })
      assert.equal(res.headers.location, '/', next)
    }
  } finally {
    await env.close()
  }
})

test('too many failed logins are blocked', async () => {
  const env = await setup(() => ({ state: 'starting' }))
  try {
    for (let i = 0; i < 10; i++) await call(env.port, '/_dig/login', { method: 'POST', body: 'password=nope' })
    const res = await call(env.port, '/_dig/login', { method: 'POST', body: `password=${PASSWORD}` })
    assert.equal(res.status, 429)
  } finally {
    await env.close()
  }
})

test('logged in: proxies to the preview, rewrites Host, strips the session cookie', async () => {
  let env!: Awaited<ReturnType<typeof setup>>
  env = await setup(() => ({ state: 'ready', target: env.target }))
  try {
    const cookie = await loginCookie(env.port)
    const res = await call(env.port, '/src/main.ts?v=1', { cookie: `${cookie}; app=1` })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'hello from /src/main.ts?v=1')
    assert.equal(res.headers['set-cookie']?.[0], 'app=1')
    assert.equal(res.headers['x-robots-tag'], 'noindex')
    const seen = env.up.seen.at(-1)!
    assert.equal(seen.headers.host, `localhost:${env.up.port}`)
    assert.equal(seen.headers.cookie, 'app=1')
    assert.equal(seen.headers['x-forwarded-host'], 'dashboard.preview.test')
    assert.deepEqual(env.ensured, ['dashboard'])
  } finally {
    await env.close()
  }
})

test('unknown project is 404, starting preview is 503 with refresh', async () => {
  const env = await setup(() => ({ state: 'starting' }))
  try {
    const cookie = await loginCookie(env.port)
    assert.equal((await call(env.port, '/', { cookie, host: 'other.preview.test' })).status, 404)
    assert.equal((await call(env.port, '/', { cookie, host: 'preview.test' })).status, 404)
    assert.equal((await call(env.port, '/', { cookie, host: 'dashboard.preview.test.evil.com' })).status, 404)
    const starting = await call(env.port, '/', { cookie })
    assert.equal(starting.status, 503)
    assert.match(starting.body, /http-equiv="refresh"/)
  } finally {
    await env.close()
  }
})

function upgrade(port: number, cookie?: string, origin?: string) {
  return new Promise<string>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /hmr HTTP/1.1\r\nHost: dashboard.preview.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}${origin ? `Origin: ${origin}\r\n` : ''}\r\n`,
      )
    })
    let data = ''
    socket.on('data', (d) => {
      data += d
      if (data.includes('101 Switching') && !data.includes('echo:')) socket.write('ping')
      if (data.includes('echo:ping') || data.startsWith('HTTP/1.1 4')) {
        socket.destroy()
        resolve(data)
      }
    })
    socket.on('close', () => resolve(data))
  })
}

test('websocket upgrades need a session and are tunneled', async () => {
  let env!: Awaited<ReturnType<typeof setup>>
  env = await setup(() => ({ state: 'ready', target: env.target }))
  try {
    assert.match(await upgrade(env.port), /^HTTP\/1.1 401/)
    const cookie = await loginCookie(env.port)
    assert.match(await upgrade(env.port, cookie, 'https://evil.example'), /^HTTP\/1.1 403/)
    const data = await upgrade(env.port, cookie, 'http://dashboard.preview.test')
    assert.match(data, /101 Switching Protocols/)
    assert.match(data, /echo:ping/)
    const seen = env.up.seen.at(-1)!
    assert.equal(seen.url, '/hmr')
    assert.equal(seen.headers.cookie, undefined)
    assert.equal(seen.headers.upgrade, 'websocket')
    assert.equal(seen.headers.origin, `http://localhost:${env.up.port}`)
  } finally {
    await env.close()
  }
})
