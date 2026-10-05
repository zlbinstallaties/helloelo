import { createFileRoute } from '@tanstack/react-router'
import { gatewayConfigured } from '#/lib/gateway.server'

// GET /api/health: liveness plus whether the Odoo gateway is configured.
// Does not call Odoo, so it stays cheap enough for frequent probes.
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const gateway = gatewayConfigured()
        return Response.json(
          {
            status: gateway ? 'ok' : 'degraded',
            server: { status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString(), runtime: 'node' },
            gateway: { configured: gateway },
          },
          { status: gateway ? 200 : 503 },
        )
      },
    },
  },
})
