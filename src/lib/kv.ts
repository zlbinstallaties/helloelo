import { kv } from '@helloleo/runtime'

/**
 * Key-value store — @helloleo/runtime `kv`. Use this file as the base for
 * caches, sessions, counters and flags. Same import in dev and production;
 * never install redis/ioredis or branch on environment.
 *
 * The raw contract (values are ALWAYS strings):
 *
 *   await kv.put('session:abc', value, { expirationTtl: 3600 })  // ttl in seconds, optional
 *   await kv.get('session:abc')                                  // string | null
 *   await kv.delete('session:abc')
 *   await kv.list({ prefix: 'session:', limit: 100 })            // { keys, cursor, listComplete }
 *
 * Rules:
 * - Server-side only (route handlers, loaders, server functions) — the
 *   binding does not exist in the browser or at app module scope.
 * - KV is for small, hot values. Relational data belongs in the database
 *   (`#/db`); files belong in storage (`#/lib/storage`).
 * - Keys are flat strings — namespace with prefixes ('cache:', 'session:').
 * - Caching a heavy read is NOT a raw kv.put: use `#/lib/cache`, which gives
 *   the read a TTL and a row in Settings → Cache the user can see the age of
 *   and purge. Hand-rolling it here hides the cache from them entirely.
 */

/** JSON convenience wrappers — kv stores strings, most values are objects. */
export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await kv.get(key)
  return raw === null ? null : (JSON.parse(raw) as T)
}

export async function kvPutJson(
  key: string,
  value: unknown,
  opts?: { expirationTtl?: number },
): Promise<void> {
  await kv.put(key, JSON.stringify(value), opts)
}

export { kv }
