// Production server: `bun run build`, then `node scripts/serve.mjs`.
// Serves the client assets from dist/client and everything else through the
// TanStack Start server entry. PORT (default 3000) and HOST (default 0.0.0.0).
import { serve } from 'srvx/node'
import { serveStatic } from 'srvx/static'

const { default: app } = await import(new URL('../dist/server/server.js', import.meta.url).href)

serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? '0.0.0.0',
  middleware: [serveStatic({ dir: new URL('../dist/client', import.meta.url).pathname })],
  fetch: (request) => app.fetch(request),
})
