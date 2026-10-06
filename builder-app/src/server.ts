import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLoginLimiter, parseCookies, verifyPassword, type Sessions } from '../../sandbox/src/auth.ts'
import { publicProject, type Project } from './config.ts'
import type { PublicationManager } from './publish.ts'
import { RunError, type RunManager } from './runs.ts'
import { RUN_ID_PATTERN, type RunMeta, type Store } from './store.ts'

/*
 * HTTP surface of the builder app: a small JSON API, a live event stream per run and the static UI.
 *
 * Every /api call except login and session needs the session cookie. Calls that change something need
 * the header `X-Dig-Builder: 1` (a cross-site page cannot send it) and a same-site Origin.
 */

export const SESSION_COOKIE = 'dig_builder'

export interface ServerOptions {
  projects: readonly Project[]
  runs: RunManager
  /** Publishing is optional; without it every project reports publishing as disabled. */
  publications?: PublicationManager
  store: Store
  passwordHash: string
  sessions: Sessions
  secureCookies: boolean
  /** Contents of index.html, app.js and style.css. */
  assets: Readonly<Record<string, { type: string; body: string }>>
  /** Take the client address from X-Forwarded-For (only behind a trusted proxy). */
  trustProxy?: boolean
  log?: (entry: Record<string, unknown>) => void
}

const MAX_BODY_BYTES = 16 * 1024
const RELEASE_ID_PATTERN = /^[a-z0-9]{1,10}-[0-9a-f]{7}$/
const HTML_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new RunError(413, 'body_too_large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new RunError(400, 'invalid_json')
  }
}

/** The list view does not need the long fields. */
function listItem(meta: RunMeta) {
  const { summary: _summary, stat: _stat, ...rest } = meta
  return rest
}

export function createBuilderServer(options: ServerOptions) {
  const { runs, store, sessions } = options
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)))
  const limiter = createLoginLimiter()
  const projects = new Map(options.projects.map((p) => [p.id, p]))

  function client(req: IncomingMessage) {
    if (options.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
      if (forwarded) return forwarded
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  const authenticated = (req: IncomingMessage) => sessions.valid(parseCookies(req.headers.cookie).get(SESSION_COOKIE))

  function sameSite(req: IncomingMessage) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      return new URL(origin).host.toLowerCase() === (req.headers.host ?? '').toLowerCase()
    } catch {
      return false
    }
  }

  function cookie(value: string, maxAgeSeconds: number) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${options.secureCookies ? '; Secure' : ''}`
  }

  async function findRun(id: string): Promise<RunMeta> {
    if (!RUN_ID_PATTERN.test(id)) throw new RunError(404, 'run_not_found')
    const meta = await store.get(id)
    if (!meta) throw new RunError(404, 'run_not_found')
    return meta
  }

  async function events(req: IncomingMessage, res: ServerResponse, id: string) {
    await findRun(id)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    })
    const send = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    const { backlog, live, unsubscribe } = await runs.follow(id, (event) => {
      if (event.type === 'end') {
        send('end', event.detail)
        res.end()
      } else {
        send('run', event)
      }
    })
    for (const event of backlog) send('run', event)
    if (!live) {
      send('end', { finished: true })
      return res.end()
    }
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET'
    const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]

    if (method !== 'GET' && method !== 'HEAD') {
      if (req.headers['x-dig-builder'] !== '1' || !sameSite(req)) throw new RunError(403, 'forbidden')
    }

    if (parts[1] === 'session' && method === 'GET') {
      return json(res, 200, { authenticated: authenticated(req) })
    }
    if (parts[1] === 'login' && method === 'POST') {
      const who = client(req)
      if (limiter.blocked(who)) return json(res, 429, { error: 'too_many_attempts' })
      const body = await readJson(req)
      if (typeof body.password !== 'string' || !verifyPassword(body.password, options.passwordHash)) {
        limiter.fail(who)
        log({ event: 'login_failed', client: who })
        return json(res, 401, { error: 'wrong_password' })
      }
      limiter.reset(who)
      log({ event: 'login', client: who })
      return json(res, 200, { authenticated: true }, { 'set-cookie': cookie(sessions.issue(), Math.floor(sessions.ttlMs / 1000)) })
    }
    if (parts[1] === 'logout' && method === 'POST') {
      return json(res, 200, { authenticated: false }, { 'set-cookie': cookie('', 0) })
    }

    if (!authenticated(req)) throw new RunError(401, 'unauthorized')

    if (parts[1] === 'projects' && parts.length === 2 && method === 'GET') {
      const all = await store.list()
      return json(res, 200, {
        projects: options.projects.map((p) => ({
          ...publicProject(p),
          runningRunId: all.find((m) => m.projectId === p.id && m.state === 'running')?.id ?? null,
        })),
        maxConcurrent: runs.maxConcurrent,
      })
    }
    if (parts[1] === 'projects' && parts[3] === 'runs' && method === 'POST') {
      if (!projects.has(parts[2])) throw new RunError(404, 'project_not_found')
      const body = await readJson(req)
      const meta = await runs.start(parts[2], { task: body.task, effort: body.effort, maxCostUsd: body.maxCostUsd })
      log({ event: 'run_started', run: meta.id, project: meta.projectId })
      return json(res, 201, meta)
    }
    if (parts[1] === 'projects' && parts[3] === 'publication') {
      const id = parts[2]
      if (!projects.has(id)) throw new RunError(404, 'project_not_found')
      const publications = options.publications
      if (parts.length === 4 && method === 'GET') {
        return json(res, 200, publications ? await publications.status(id) : { enabled: false, url: null, current: null, releases: [], baseCommit: null, upToDate: null, job: null })
      }
      if (parts.length === 5 && method === 'POST' && ['publish', 'rollback', 'restart'].includes(parts[4])) {
        if (!publications) throw new RunError(409, 'publishing_disabled', 'Publiceren is niet ingesteld.')
        const body = await readJson(req)
        let status
        if (parts[4] === 'publish') status = await publications.publish(id)
        else if (parts[4] === 'restart') status = await publications.restart(id)
        else {
          if (body.releaseId !== undefined && (typeof body.releaseId !== 'string' || !RELEASE_ID_PATTERN.test(body.releaseId))) throw new RunError(400, 'invalid_release')
          status = await publications.rollback(id, body.releaseId as string | undefined)
        }
        log({ event: `publication_${parts[4]}_requested`, project: id })
        return json(res, 202, status)
      }
    }
    if (parts[1] === 'runs' && parts.length === 2 && method === 'GET') {
      const projectId = url.searchParams.get('project')
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1), 100)
      const all = (await store.list()).filter((m) => !projectId || m.projectId === projectId).slice(0, limit)
      return json(res, 200, { runs: all.map(listItem) })
    }
    if (parts[1] === 'runs' && parts.length === 3 && method === 'GET') {
      const meta = await findRun(parts[2])
      return json(res, 200, { ...meta, running: runs.isRunning(meta.id) })
    }
    if (parts[1] === 'runs' && parts[3] === 'diff' && method === 'GET') {
      const meta = await findRun(parts[2])
      const diff = await store.diff(meta.id)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      return res.end(diff)
    }
    if (parts[1] === 'runs' && parts[3] === 'events' && method === 'GET') {
      return events(req, res, parts[2])
    }
    if (parts[1] === 'runs' && method === 'POST' && ['stop', 'approve', 'reject'].includes(parts[3])) {
      const meta = await findRun(parts[2])
      if (parts[3] === 'stop') {
        runs.stop(meta.id)
        return json(res, 202, { stopping: true })
      }
      const decided = parts[3] === 'approve' ? await runs.approve(meta.id) : await runs.reject(meta.id)
      log({ event: `run_${decided.decision}`, run: decided.id })
      return json(res, 200, { ...decided, running: false })
    }
    throw new RunError(404, 'not_found')
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now()
    const url = new URL(req.url ?? '/', 'http://builder.local')
    let status = 200
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url)
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        const asset = Object.hasOwn(options.assets, name) ? options.assets[name] : undefined
        if (!asset) throw new RunError(404, 'not_found')
        res.writeHead(200, {
          'content-type': asset.type,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
          ...(asset.type.startsWith('text/html') ? { 'content-security-policy': HTML_CSP } : {}),
        })
        res.end(req.method === 'HEAD' ? undefined : asset.body)
      } else {
        throw new RunError(405, 'method_not_allowed')
      }
      status = res.statusCode
    } catch (error) {
      const failure = error instanceof RunError ? error : null
      status = failure?.status ?? 500
      if (!failure) log({ event: 'error', message: error instanceof Error ? error.message : String(error) })
      if (!res.headersSent) json(res, status, { error: failure?.code ?? 'internal_error', message: failure?.message })
      else res.end()
    } finally {
      if (!url.pathname.endsWith('/events')) log({ event: 'request', method: req.method, path: url.pathname.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+/g, ':run'), status, ms: Date.now() - started })
    }
  }
}
