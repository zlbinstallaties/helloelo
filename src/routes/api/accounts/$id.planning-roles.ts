import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// GET /api/accounts/:id/planning-roles: the planning roles of the technician of this account in Odoo. PUT: change them. Admins only.
// Only an account of a technician that is linked to an Odoo employee (employee:<id>) qualifies.
export const Route = createFileRoute('/api/accounts/$id/planning-roles')({
  server: {
    handlers: {
      GET: ({ request, params }) => getHandlers().accountRolesGet(request, params.id),
      PUT: ({ request, params }) => getHandlers().accountRolesSet(request, params.id),
    },
  },
})
