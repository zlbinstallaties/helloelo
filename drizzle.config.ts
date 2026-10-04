import { defineConfig } from 'drizzle-kit'

// src/db/schema.ts is the single source of truth for the D1 / libsql schema.
//
// Migrations (drizzle/*.sql + drizzle/meta/) are GENERATED from schema.ts by
// HelloLeo after every schema change and applied automatically -- in dev on
// server start, in production when you publish. Never edit or delete files
// under drizzle/ by hand; change schema.ts instead. Prefer adding new
// columns/tables over renaming existing ones (renames cannot be generated).

const devDbPath = process.env.DEV_DB_PATH ?? '.dev.db'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: `file:${devDbPath}` },
})
