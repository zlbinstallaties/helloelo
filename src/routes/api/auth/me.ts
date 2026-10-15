import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

export const Route = createFileRoute('/api/auth/me')({
  server: { handlers: { GET: ({ request }) => getHandlers().me(request) } },
})
