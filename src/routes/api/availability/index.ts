import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// GET /api/availability: the periods technicians are not available (a technician: his own, the planner: everyone's).
// POST /api/availability: a technician adds a period. The logic is in src/lib/availability-handlers.ts (tested with mocks).
export const Route = createFileRoute('/api/availability/')({
  server: {
    handlers: {
      GET: ({ request }) => getHandlers().availabilityList(request),
      POST: ({ request }) => getHandlers().availabilityAdd(request),
    },
  },
})
