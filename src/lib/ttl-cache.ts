/*
 * Small in-memory cache for one expensive server-side read.
 *
 *   const getData = withCache('odoo:dashboard', 300, load)
 *   await getData()          // cached for 300 s
 *   await getData.refresh()  // force a new read
 *
 * Concurrent callers share one in-flight read. A failed read is not cached.
 * The cache lives per server process, which fits a single-instance app.
 */

export interface CachedRead<T> {
  (): Promise<T>
  refresh(): Promise<T>
}

export function withCache<T>(key: string, ttlSeconds: number, load: () => Promise<T>, now: () => number = Date.now): CachedRead<T> {
  let value: { data: T; expires: number } | null = null
  let inFlight: Promise<T> | null = null

  function read() {
    inFlight ??= load()
      .then((data) => {
        value = { data, expires: now() + ttlSeconds * 1000 }
        return data
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const cached = (async () => {
    if (value && value.expires > now()) return value.data
    return read()
  }) as CachedRead<T>
  cached.refresh = () => {
    value = null
    return read()
  }
  Object.defineProperty(cached, 'name', { value: `cached:${key}` })
  return cached
}
