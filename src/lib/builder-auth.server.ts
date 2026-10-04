import { callIntegration } from '#/lib/proxy.server'
import { kv, kvGetJson, kvPutJson } from '#/lib/kv'
import { env } from '@helloleo/runtime'

const SESSION_COOKIE = 'dig_builder_session'
const SESSION_TTL = 8 * 60 * 60
const GROUP_NAME = 'DIG Builder Administrator'

export type BuilderSession = {
  uid: number
  login: string
  name: string
}

type OdooAuthResult = number | { uid?: number; name?: string }
type OdooGroup = [number, string]

function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${env.NODE_ENV === 'production' ? '; Secure' : ''}`
}

function readSessionId(request: Request) {
  const value = request.headers.get('cookie') ?? ''
  const match = value.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  return match?.[1] ?? null
}

async function authenticate(login: string, password: string) {
  const response = await callIntegration<OdooAuthResult>({
    integration: 'odoo',
    endpoint: '/jsonrpc',
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      method: 'call',
      params: { service: 'common', method: 'authenticate', args: [null, login, password, {}] },
      id: 1,
    },
  })
  if (!response.success) return null
  const uid = typeof response.data === 'number' ? response.data : response.data?.uid
  if (!uid || uid <= 0) return null
  return { uid, name: typeof response.data === 'object' ? response.data?.name ?? login : login }
}

async function isBuilderAdmin(login: string) {
  const groupResponse = await callIntegration<{ id: number; name: string }[]>({
    integration: 'odoo',
    endpoint: '/jsonrpc',
    method: 'POST',
    body: { model: 'res.groups', method: 'search_read', args: [[['name', '=', GROUP_NAME]]], kwargs: { fields: ['id', 'name'], limit: 1, offset: 0 } },
  })
  const groupId = groupResponse.success ? groupResponse.data?.[0]?.id : undefined
  if (!groupId) return false

  const userResponse = await callIntegration<{ id: number; login: string; name: string; all_group_ids: OdooGroup[] }[]>({
    integration: 'odoo',
    endpoint: '/jsonrpc',
    method: 'POST',
    body: { model: 'res.users', method: 'search_read', args: [[['login', '=', login]]], kwargs: { fields: ['id', 'login', 'name', 'all_group_ids'], limit: 1, offset: 0 } },
  })
  const groups = userResponse.success ? userResponse.data?.[0]?.all_group_ids ?? [] : []
  return groups.some((group) => Array.isArray(group) && group[0] === groupId)
}

export async function loginBuilderUser(request: Request) {
  const body = await request.json().catch(() => null) as { login?: unknown; password?: unknown } | null
  if (typeof body?.login !== 'string' || typeof body.password !== 'string' || !body.login || !body.password) {
    return Response.json({ error: 'login_required' }, { status: 400 })
  }
  const identity = await authenticate(body.login, body.password)
  if (!identity || !(await isBuilderAdmin(body.login))) {
    return Response.json({ error: 'builder_admin_required' }, { status: 403 })
  }
  const sessionId = crypto.randomUUID()
  await kvPutJson(`dig-builder:session:${sessionId}`, { uid: identity.uid, login: body.login, name: identity.name }, { expirationTtl: SESSION_TTL })
  return Response.json(
    { user: { uid: identity.uid, login: body.login, name: identity.name } },
    { headers: { 'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; ${cookieOptions()}` } },
  )
}

export async function getBuilderSession(request: Request): Promise<BuilderSession | null> {
  const sessionId = readSessionId(request)
  return sessionId ? kvGetJson<BuilderSession>(`dig-builder:session:${sessionId}`) : null
}

export async function logoutBuilderUser(request: Request) {
  const sessionId = readSessionId(request)
  if (sessionId) await kv.delete(`dig-builder:session:${sessionId}`)
  return new Response(null, { status: 204, headers: { 'Set-Cookie': `${SESSION_COOKIE}=; ${cookieOptions()}; Max-Age=0` } })
}
