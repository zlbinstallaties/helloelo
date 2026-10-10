import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// POST /api/employees: add a technician as an employee in Odoo (no Odoo user) plus a portal account. Admins only.
// The logic is in src/lib/employee-service.ts and admin-handlers.ts (tested with mocks); this file connects it.
export const Route = createFileRoute('/api/employees')({
  server: { handlers: { POST: ({ request }) => getHandlers().employeesCreate(request) } },
})
