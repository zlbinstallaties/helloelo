import { createFileRoute } from '@tanstack/react-router'
import { getHandlers } from '#/lib/wiring.server'

// POST /api/documents: a filled-in schouw or oplever document with the signature of the customer; the server makes the
// PDF and puts it on the customer in Odoo through the gateway. The logic is in src/lib/document-handlers.ts (tested with mocks).
export const Route = createFileRoute('/api/documents')({
  server: {
    handlers: {
      POST: ({ request }) => getHandlers().documentsPost(request),
    },
  },
})
