import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'drizzle-orm'
import { db } from '#/db'

/**
 * Server route example: GET /api/health. Use this file as the base for
 * building JSON APIs (CRUD endpoints, webhooks) with TanStack Start
 * server routes:
 * https://tanstack.com/start/latest/docs/framework/react/guide/server-routes
 *
 * How server routes work:
 * - Files under src/routes/ can export server handlers. The URL matches
 *   the file path: src/routes/api/health.ts serves /api/health.
 * - Add one handler per HTTP method under server.handlers (GET, POST,
 *   PUT, PATCH, DELETE). A handler receives ({ request, params }) and
 *   returns a Response, usually Response.json().
 * - Dynamic segments use $: src/routes/api/todos/$id.ts serves
 *   /api/todos/:id and the handler reads params.id.
 * - Read the request body with await request.json() and validate it
 *   before use. Return proper status codes (201 created, 404 not found).
 * - Query the database with `import { db } from '#/db'` INSIDE the
 *   handler, never at module scope (the binding only exists per request).
 */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const startedAt = Date.now()

        const server = {
          status: 'ok' as const,
          uptimeSeconds: Math.round(
            typeof process !== 'undefined' &&
              typeof process.uptime === 'function'
              ? process.uptime()
              : 0,
          ),
          timestamp: new Date().toISOString(),
          runtime: 'cloudflare-workers',
        }

        // Database health: schema-agnostic connectivity ping. Deliberately
        // NOT a query against an app table — the health probe must keep
        // working no matter how src/db/schema.ts evolves.
        let database: {
          status: 'ok' | 'error'
          latencyMs: number
          error: string | null
        }
        const dbStart = Date.now()
        try {
          await db.run(sql`SELECT 1`)
          database = {
            status: 'ok',
            latencyMs: Date.now() - dbStart,
            error: null,
          }
        } catch (err) {
          database = {
            status: 'error',
            latencyMs: Date.now() - dbStart,
            error: err instanceof Error ? err.message : String(err),
          }
        }

        const overall =
          server.status === 'ok' && database.status === 'ok'
            ? 'ok'
            : 'degraded'

        return Response.json(
          {
            status: overall,
            server,
            database,
            checkedInMs: Date.now() - startedAt,
          },
          { status: overall === 'ok' ? 200 : 503 },
        )
      },
    },
  },
})
