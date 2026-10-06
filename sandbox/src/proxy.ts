import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  createLoginLimiter,
  parseCookies,
  SESSION_COOKIE,
  stripSessionCookie,
  verifyPassword,
  type Sessions,
} from './auth.ts'
import { isProjectId, LIVE_SUFFIX } from './ids.ts'
import type { PreviewManager, PreviewProject, PreviewState } from './preview.ts'
import type { LiveResolver } from './release.ts'

/*
 * Login-protected reverse proxy for previews.
 *
 *   https://<project>.<PREVIEW_DOMAIN>/...        -> preview container of <project>
 *   https://<project>-live.<PREVIEW_DOMAIN>/...   -> the published version of <project>
 *   /_dig/login, /_dig/logout                -> on every host
 *
 * The session cookie is scoped to the preview domain and stripped before a
 * request reaches the app. Upstream requests get Host localhost:<port>, so
 * dev servers with a host allowlist (Vite) accept them. WebSocket upgrades
 * (HMR) are proxied after the same session check and an Origin check.
 */

export interface ProxyOptions {
  domain: string
  passwordHash: string
  sessions: Sessions
  previews: Pick<PreviewManager, 'ensure'>
  projects: ReadonlyMap<string, PreviewProject>
  /** Published versions; without it the -live hostnames do not exist. */
  live?: Pick<LiveResolver, 'exists' | 'resolve'>
  secureCookies: boolean
  log?: (entry: Record<string, unknown>) => void
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection',
])
const MAX_LOGIN_BODY = 4096

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(res: ServerResponse, status: number, title: string, body: string, extraHead = '') {
  const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${extraHead}<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:15vh auto;padding:0 1rem;color:#1f2937}input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem}button{background:#111827;color:#fff;border:0;border-radius:.4rem}p.err{color:#b91c1c}</style></head><body>${body}</body></html>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  })
  res.end(html)
}

function loginPage(res: ServerResponse, next: string, error = '', status = 200) {
  page(
    res,
    status,
    'Inloggen – DIG Preview',
    `<h1>DIG Preview</h1>${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}<form method="post" action="/_dig/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Wachtwoord<input type="password" name="password" autocomplete="current-password" required autofocus></label><button type="submit">Inloggen</button></form>`,
  )
}

/** Only same-host relative paths; anything else falls back to "/". */
function safeNext(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  return value.slice(0, 2000)
}

function hostname(req: IncomingMessage) {
  return (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
}

function clientAddress(req: IncomingMessage) {
  return req.socket.remoteAddress ?? 'unknown'
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_LOGIN_BODY) return null
    chunks.push(chunk as Buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/** True when the Origin header (if any) is this preview host itself. */
function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host.toLowerCase() === (req.headers.host ?? '').toLowerCase()
  } catch {
    return false
  }
}

function upstreamHeaders(req: IncomingMessage, target: URL) {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key) || key === 'host' || key === 'cookie') continue
    headers[key] = value
  }
  const cookie = stripSessionCookie(req.headers.cookie)
  if (cookie) headers.cookie = cookie
  headers.host = `localhost:${target.port}`
  // Dev servers compare Origin with Host; a same-origin request keeps passing that check.
  if (req.headers.origin && sameOrigin(req)) headers.origin = `http://localhost:${target.port}`
  headers['x-forwarded-host'] = req.headers.host ?? ''
  headers['x-forwarded-proto'] = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'
  headers['x-forwarded-for'] = clientAddress(req)
  return headers
}

export function createPreviewProxy(options: ProxyOptions) {
  const { domain, sessions, projects } = options
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)))
  const limiter = createLoginLimiter()
  // Browsers do not share cookies set for "localhost" across subdomains; use host-only there.
  const cookieDomain = domain === 'localhost' ? '' : `; Domain=${domain}`

  type Target = { kind: 'preview'; project: PreviewProject } | { kind: 'live'; id: string }

  function targetFor(req: IncomingMessage): Target | null {
    return targetForHost(hostname(req))
  }

  function targetForHost(host: string): Target | null {
    if (!host.endsWith(`.${domain}`)) return null
    const label = host.slice(0, -(domain.length + 1))
    if (label.endsWith(LIVE_SUFFIX)) {
      const id = label.slice(0, -LIVE_SUFFIX.length)
      return options.live && isProjectId(id) ? { kind: 'live', id } : null
    }
    const project = projects.get(label)
    return project ? { kind: 'preview', project } : null
  }

  /** The upstream of a target, or why there is none. */
  async function upstreamOf(target: Target): Promise<PreviewState | { state: 'none' } | { state: 'down' }> {
    if (target.kind === 'preview') return options.previews.ensure(target.project)
    return options.live!.resolve(target.id)
  }

  function authenticated(req: IncomingMessage) {
    return sessions.valid(parseCookies(req.headers.cookie).get(SESSION_COOKIE))
  }

  function cookie(value: string, maxAgeSeconds: number) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieDomain}${options.secureCookies ? '; Secure' : ''}`
  }

  /** Caddy on-demand TLS "ask": only hostnames of configured projects get a certificate. */
  function allowedHostname(res: ServerResponse, url: URL) {
    const target = targetForHost((url.searchParams.get('domain') ?? '').toLowerCase())
    const known = target?.kind === 'preview' || (target?.kind === 'live' && options.live!.exists(target.id))
    res.writeHead(known ? 200 : 404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    res.end(known ? 'ok' : 'unknown')
  }

  async function login(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method === 'GET') return loginPage(res, safeNext(url.searchParams.get('next')))
    if (req.method !== 'POST') return page(res, 405, 'Niet toegestaan', '<p>Methode niet toegestaan.</p>')
    const client = clientAddress(req)
    if (limiter.blocked(client)) return loginPage(res, '/', 'Te veel pogingen. Probeer het later opnieuw.', 429)
    const form = await readForm(req)
    const next = safeNext(form?.get('next'))
    if (!form || !verifyPassword(form.get('password') ?? '', options.passwordHash)) {
      limiter.fail(client)
      log({ event: 'login_failed', client })
      return loginPage(res, next, 'Onjuist wachtwoord.', 401)
    }
    limiter.reset(client)
    log({ event: 'login', client })
    res.writeHead(303, {
      location: next,
      'set-cookie': cookie(sessions.issue(), Math.floor(sessions.ttlMs / 1000)),
      'cache-control': 'no-store',
    })
    res.end()
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://preview.local')
    try {
      if (url.pathname === '/_dig/allowed') return allowedHostname(res, url)
      if (url.pathname === '/_dig/login') return await login(req, res, url)
      if (url.pathname === '/_dig/logout') {
        res.writeHead(303, { location: '/_dig/login', 'set-cookie': cookie('', 0) })
        return res.end()
      }
      if (!authenticated(req)) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          res.writeHead(302, { location: `/_dig/login?next=${encodeURIComponent(url.pathname + url.search)}` })
          return res.end()
        }
        return page(res, 401, 'Niet ingelogd', '<p>Log eerst in.</p>')
      }
      const route = targetFor(req)
      if (!route) return page(res, 404, 'Onbekende preview', '<p>Deze preview bestaat niet.</p>')

      const state = await upstreamOf(route)
      if (state.state === 'none') return page(res, 404, 'Nog niet gepubliceerd', '<h1>Nog niet gepubliceerd</h1><p>Van deze app is nog geen versie gepubliceerd.</p>')
      if (state.state === 'down') {
        res.setHeader('retry-after', '10')
        return page(res, 503, 'Niet beschikbaar', '<h1>Tijdelijk niet beschikbaar</h1><p>De gepubliceerde versie draait op dit moment niet. Probeer het zo opnieuw.</p>', '<meta http-equiv="refresh" content="10">')
      }
      if (state.state !== 'ready') {
        res.setHeader('retry-after', '2')
        return page(
          res,
          503,
          'Preview wordt gestart',
          '<h1>Preview wordt gestart…</h1><p>Deze pagina ververst vanzelf.</p>',
          '<meta http-equiv="refresh" content="2">',
        )
      }
      const target = new URL(state.target)
      const upstream = httpRequest(
        { host: target.hostname, port: target.port, method: req.method, path: url.pathname + url.search, headers: upstreamHeaders(req, target) },
        (up) => {
          const headers: Record<string, string | string[]> = {}
          for (const [key, value] of Object.entries(up.headers)) {
            if (value !== undefined && !HOP_BY_HOP.has(key)) headers[key] = value
          }
          headers['x-robots-tag'] = 'noindex'
          res.writeHead(up.statusCode ?? 502, headers)
          up.pipe(res)
        },
      )
      upstream.on('error', () => {
        if (!res.headersSent) page(res, 502, 'Preview niet bereikbaar', '<p>De preview reageert niet.</p>')
        else res.destroy()
      })
      req.pipe(upstream)
    } catch (error) {
      log({ event: 'proxy_error', message: error instanceof Error ? error.message : String(error) })
      if (!res.headersSent) page(res, 500, 'Fout', '<p>Er ging iets mis bij het starten van de preview.</p>')
    }
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: string) => {
      log({ event: 'upgrade_rejected', status, host: req.headers.host ?? null, origin: req.headers.origin ?? null })
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    try {
      if (!authenticated(req)) return reject('401 Unauthorized')
      // Cross-site WebSocket hijacking: the cookie is sent from any site, so check Origin.
      if (!sameOrigin(req)) return reject('403 Forbidden')
      const route = targetFor(req)
      if (!route) return reject('404 Not Found')
      const state = await upstreamOf(route)
      if (state.state !== 'ready') return reject('503 Service Unavailable')
      const target = new URL(state.target)
      const headers = upstreamHeaders(req, target)
      headers.connection = 'Upgrade'
      headers.upgrade = req.headers.upgrade ?? 'websocket'
      const upstream = connect({ host: target.hostname, port: Number(target.port) }, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`]
        for (const [key, value] of Object.entries(headers)) {
          for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${v}`)
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    } catch {
      reject('500 Internal Server Error')
    }
  }

  return { handleRequest, handleUpgrade }
}
