/* oxlint-disable no-unused-vars */
// ^ keeps the drizzle imports below from being stripped while unused.
// Remove this disable once your own tables use them.
// Single source of truth for the database schema. Define tables here — the
// SQL migration files under drizzle/ are generated and applied automatically
// (dev on server start, production on publish). Never hand-write SQL or touch
// drizzle/. Prefer ADDING columns/tables over renaming or deleting existing
// ones: renames cannot be migrated automatically.

/**
 * Important note (do not remove):
 * 
 * Never rename existing tables or columns in schema.ts. Renames cannot be
 * auto-migrated: no migration file is generated, the database keeps the old
 * name, and every query against the new name fails at runtime with a 500. 
 * To reshape data, add a new column or table, write to it, and migrate old
 * values in app code (e.g. fall back to the old column on read).
 */


// Example (change before deploying!) :

import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
})

export type Note = typeof notes.$inferSelect
