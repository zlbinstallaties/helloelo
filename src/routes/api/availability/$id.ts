import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// DELETE /api/availability/:id: a technician removes a period of his own.
export const Route = createFileRoute('/api/availability/$id')({
  server: { handlers: { DELETE: ({ request, params }) => getHandlers().availabilityRemove(request, params.id) } },
})
