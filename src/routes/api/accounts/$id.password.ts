import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// POST /api/accounts/:id/password: a new generated password, shown once. Admins only.
export const Route = createFileRoute('/api/accounts/$id/password')({
  server: { handlers: { POST: ({ request, params }) => getHandlers().accountsResetPassword(request, params.id) } },
})
