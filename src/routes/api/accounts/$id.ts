import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// PATCH /api/accounts/:id and DELETE /api/accounts/:id. Admins only.
export const Route = createFileRoute('/api/accounts/$id')({
  server: {
    handlers: {
      PATCH: ({ request, params }) => getHandlers().accountsUpdate(request, params.id),
      DELETE: ({ request, params }) => getHandlers().accountsRemove(request, params.id),
    },
  },
})
