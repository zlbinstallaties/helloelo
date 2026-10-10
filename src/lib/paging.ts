/*
 * Reads every record of a model in pages. No I/O of its own (the page reader is passed in), so it is
 * unit-tested in test/.
 *
 * The gateway answers one page per call and does not report a total, so a page that is not full is the
 * end. A hard maximum keeps one dashboard from loading an unbounded number of records into memory; when
 * it is reached `truncated` says whether anything was left behind, so the screen can warn about it
 * instead of silently showing an incomplete picture.
 */

/** Records per call. The gateway refuses a limit above `maxLimit` of the project (500 in the example). */
export const PAGE_SIZE = 500
/** Records per model the dashboard reads at most. */
export const MAX_RECORDS = 5000

export type PagedResult<T> = { records: T[]; truncated: boolean }

export async function readAllPages<T extends { id: number }>(
  readPage: (offset: number, limit: number) => Promise<T[]>,
  options: { pageSize?: number; maxRecords?: number } = {},
): Promise<PagedResult<T>> {
  const pageSize = options.pageSize ?? PAGE_SIZE
  const maxRecords = options.maxRecords ?? MAX_RECORDS
  const records: T[] = []
  const seen = new Set<number>()
  let offset = 0

  while (offset < maxRecords) {
    const limit = Math.min(pageSize, maxRecords - offset)
    const page = await readPage(offset, limit)
    // Offset paging can show a record twice when the data moves between two calls; keep it once.
    for (const record of page) {
      if (seen.has(record.id)) continue
      seen.add(record.id)
      records.push(record)
    }
    offset += page.length
    if (page.length < limit) return { records, truncated: false }
  }

  // The maximum was reached with a full page: look for one more record to know whether it was the end.
  const more = await readPage(offset, 1)
  return { records, truncated: more.length > 0 }
}
