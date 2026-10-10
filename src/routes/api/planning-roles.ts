import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// GET /api/planning-roles: the roles a planner can choose for a new technician, read from Odoo through the gateway.
// Admins only. The logic is in src/lib/admin-handlers.ts (tested with mocks); this file connects it.
export const Route = createFileRoute('/api/planning-roles')({
  server: { handlers: { GET: ({ request }) => getHandlers().planningRolesList(request) } },
})
