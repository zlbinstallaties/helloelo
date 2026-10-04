import { createFileRoute } from '@tanstack/react-router'
import { getBuilderSession } from '#/lib/builder-auth.server'
import { callBuilder } from '#/lib/builder.server'

export const Route = createFileRoute('/api/builder')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await getBuilderSession(request))) return Response.json({ error: 'authentication_required' }, { status: 401 })
        const action = new URL(request.url).searchParams.get('action') ?? 'projects'
        return callBuilder(action === 'providers' ? '/api/providers' : '/api/projects')
      },
      POST: async ({ request }) => {
        if (!(await getBuilderSession(request))) return Response.json({ error: 'authentication_required' }, { status: 401 })
        const body = await request.json().catch(() => null) as { action?: string; id?: string; description?: string; provider?: string; model?: string } | null
        if (body?.action === 'proposal' && body.id) return callBuilder(`/api/projects/${encodeURIComponent(body.id)}/proposal`, { method: 'POST', body: '{}' })
        if (body?.action === 'create') return callBuilder('/api/projects', { method: 'POST', body: JSON.stringify({ description: body.description, provider: body.provider, model: body.model }) })
        return Response.json({ error: 'invalid_builder_action' }, { status: 400 })
      },
    },
  },
})
