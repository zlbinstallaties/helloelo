import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

export const Route = createFileRoute('/api/auth/logout')({
  server: { handlers: { POST: ({ request }) => getHandlers().logout(request) } },
})
