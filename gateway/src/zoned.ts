/*
 * Whole calendar days in a time zone, as the `YYYY-MM-DD HH:MM:SS` (UTC) strings Odoo keeps. "From 12 October to 13
 * October" for a person in the Netherlands is 12 October 00:00:00 until 13 October 23:59:59 local time, which in
 * summer time is 11 October 22:00:00 until 13 October 21:59:59 UTC. Daylight saving time is looked up per end, so a
 * period over the change of the clocks is right at both ends. Uses only what Node knows (Intl); nothing is guessed:
 * an unknown time zone is an error.
 */

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** How many minutes the clocks of `tz` are ahead of UTC at this moment. */
function offsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
  const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
  return (local - Math.floor(utcMs / 1000) * 1000) / 60_000
}

/** The UTC moment at which the clocks of `tz` show this date and time. */
function localToUtc(day: string, hour: number, minute: number, second: number, tz: string): number {
  const [year, month, date] = day.split('-').map(Number)
  const guess = Date.UTC(year, month - 1, date, hour, minute, second)
  const first = guess - offsetMinutes(guess, tz) * 60_000
  // The offset at the first guess can differ from the one at the real moment, around the change of the clocks.
  return guess - offsetMinutes(first, tz) * 60_000
}

const format = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

function checkDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`not a calendar day: ${String(value)}`)
  }
  return value
}

/** From the start of `from` until the last second of `to` (both days included), in `tz`, as Odoo UTC strings. */
export function dayRangeInUtc(from: unknown, to: unknown, tz: unknown): { dateFrom: string; dateTo: string } {
  const first = checkDay(from)
  const last = checkDay(to)
  if (last < first) throw new Error('the last day is before the first day')
  if (!isTimeZone(tz)) throw new Error(`not a time zone: ${String(tz)}`)
  return { dateFrom: format(localToUtc(first, 0, 0, 0, tz)), dateTo: format(localToUtc(last, 23, 59, 59, tz)) }
}
