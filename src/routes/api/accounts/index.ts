import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// GET /api/accounts: accounts and the people of the planning. POST: an account for a person of the planning. Admins only.
export const Route = createFileRoute('/api/accounts/')({
  server: {
    handlers: {
      GET: ({ request }) => getHandlers().accountsList(request),
      POST: ({ request }) => getHandlers().accountsCreate(request),
    },
  },
})
