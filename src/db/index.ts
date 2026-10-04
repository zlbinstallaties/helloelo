import { createDb } from '@helloleo/runtime'
import * as schema from '#/db/schema'

// Typed Drizzle client over the D1 binding — real D1 in prod, the cf-shim's
// libsql-backed .dev.db in dev. `db` is a lazy Proxy: use it as `db.select()…`
// (NOT `db()`), and only INSIDE a request (route loader, server function, or
// API handler) — the Cloudflare binding does not exist at module scope.
export const db = createDb(schema)
export { schema }
