import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// POST /api/availability/:id/retry: sends a period of the technician himself to Odoo again (when it was refused or never sent).
export const Route = createFileRoute('/api/availability/$id/retry')({
  server: { handlers: { POST: ({ request, params }) => getHandlers().availabilityRetry(request, params.id) } },
})
