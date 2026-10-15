import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

export const Route = createFileRoute('/api/auth/password')({
  server: { handlers: { POST: ({ request }) => getHandlers().changePassword(request) } },
})
