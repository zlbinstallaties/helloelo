import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// GET /api/dashboard: the appointments this person may see. POST: refresh from Odoo, admins only.
// The logic is in src/lib/handlers.ts (tested without a server); this file only connects it.
export const Route = createFileRoute('/api/dashboard')({
  server: {
    handlers: {
      GET: ({ request }) => getHandlers().dashboardGet(request),
      POST: ({ request }) => getHandlers().dashboardRefresh(request),
    },
  },
})
