import { createFileRoute } from '@tanstack/react-router'
import { getBuilderSession } from '#/lib/builder-auth.server'

export const Route = createFileRoute('/api/auth/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await getBuilderSession(request)
        return user ? Response.json({ user }) : Response.json({ error: 'authentication_required' }, { status: 401 })
      },
    },
  },
})
