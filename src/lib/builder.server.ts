import { env } from '@helloleo/runtime'

const runtimeEnv = env as unknown as { BUILDER_API_URL?: string; BUILDER_ADMIN_TOKEN?: string }

export async function callBuilder(path: string, init?: RequestInit) {
  if (!runtimeEnv.BUILDER_API_URL || !runtimeEnv.BUILDER_ADMIN_TOKEN) {
    return Response.json({ error: 'builder_service_not_configured' }, { status: 503 })
  }
  return fetch(`${runtimeEnv.BUILDER_API_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtimeEnv.BUILDER_ADMIN_TOKEN}`, ...init?.headers },
  })
}
