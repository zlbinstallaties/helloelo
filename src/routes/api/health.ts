import { createFileRoute } from '@tanstack/react-router'
import { gatewayConfigured } from '#/lib/gateway.server'
import { authMode, sessionSecretConfigured } from '#/lib/wiring.server'

// GET /api/health: liveness plus whether the Odoo gateway and the logins are set up.
// Does not call Odoo, so it stays cheap enough for frequent probes. Degraded (503) while something that the
// dashboard needs is not set up, so that a misconfigured version never goes live.
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const gateway = gatewayConfigured()
        const mode = authMode()
        const auth = mode === 'off' || sessionSecretConfigured()
        const ok = gateway && auth
        return Response.json(
          {
            status: ok ? 'ok' : 'degraded',
            server: { status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString(), runtime: 'node' },
            gateway: { configured: gateway },
            auth: { mode, configured: auth },
          },
          { status: ok ? 200 : 503 },
        )
      },
    },
  },
})
