import { randomUUID } from 'node:crypto'
import type { AccountIo } from './accounts.ts'

/*
 * The periods in which a technician is NOT available (holiday, ill, an appointment), as the technician filled
 * them in. One period is a first day and a last day (both included) and an optional note. Dates are plain
 * calendar days ("2026-10-07"), the way the technician sees them in the Netherlands; no times, no time zones.
 *
 * Kept in a file of its own (availability.json), written whole and atomically like the accounts. No I/O of its
 * own (`AccountIo`), so it is unit-tested in test/. A damaged file is refused as a whole, never repaired.
 */

export type Period = {
  id: string
  /** The account (id) of the technician it belongs to. */
  accountId: string
  /** First day, included. */
  from: string
  /** Last day, included. */
  to: string
  note: string
  createdAt: string
}

export class AvailabilityError extends Error {
  code: 'invalid' | 'conflict' | 'not_found' | 'limit'

  constructor(code: 'invalid' | 'conflict' | 'not_found' | 'limit', message: string) {
    super(message)
    this.name = 'AvailabilityError'
    this.code = code
  }
}

export class AvailabilityFileError extends Error {
  constructor(message: string) {
    super(`Het beschikbaarheidsbestand is ongeldig: ${message}`)
    this.name = 'AvailabilityFileError'
  }
}

const FILE_VERSION = 1
export const MAX_NOTE = 200
export const MAX_SPAN_DAYS = 366
export const MAX_AHEAD_DAYS = 730
export const MAX_PER_PERSON = 50
const KEEP_PAST_DAYS = 30
const MAX_TOTAL = 5000
const DAY_MS = 86_400_000
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
/** Line breaks and other control characters (including the Unicode line and paragraph separators). */
function hasControl(text: string) {
  for (const char of text) {
    const code = char.codePointAt(0) as number
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}

/** The day number of a real calendar date, or null when it is not one. */
function dayNumber(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = DATE.exec(value)
  if (!match) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return new Date(time).toISOString().slice(0, 10) === value ? time / DAY_MS : null
}

const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)

function checkNote(value: unknown): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > MAX_NOTE || hasControl(value)) return null
  return value.trim()
}

function parse(text: string | null): Period[] {
  if (text === null) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new AvailabilityFileError('geen geldige JSON.')
  }
  const file = data as { version?: unknown; periods?: unknown } | null
  if (typeof file !== 'object' || file === null || Array.isArray(file) || file.version !== FILE_VERSION || !Array.isArray(file.periods)) {
    throw new AvailabilityFileError(`verwacht { "version": ${FILE_VERSION}, "periods": [...] }.`)
  }
  const seen = new Set<string>()
  return file.periods.map((raw: unknown, index: number): Period => {
    const p = raw as Record<string, unknown>
    const from = dayNumber(p?.from)
    const to = dayNumber(p?.to)
    if (
      typeof p?.id !== 'string' || !p.id || typeof p.accountId !== 'string' || !p.accountId ||
      from === null || to === null || to < from || to - from + 1 > MAX_SPAN_DAYS ||
      typeof p.note !== 'string' || p.note.length > MAX_NOTE || hasControl(p.note) || typeof p.createdAt !== 'string'
    ) {
      throw new AvailabilityFileError(`periode ${index + 1} mist een veld of heeft een onjuiste waarde.`)
    }
    if (seen.has(p.id)) throw new AvailabilityFileError(`periode ${index + 1}: dubbel id.`)
    seen.add(p.id)
    return p as unknown as Period
  })
}

export function createAvailabilityStore(options: { io: AccountIo; now?: () => Date; newId?: () => string }) {
  const { io } = options
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? (() => `p_${randomUUID().replaceAll('-', '')}`)

  /** Today as a calendar day in the Netherlands. */
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(now())
  const load = () => parse(io.read())

  function save(periods: Period[]) {
    // What ended more than 30 days ago is of no use to anyone any more.
    const cutoff = (dayNumber(today()) as number) - KEEP_PAST_DAYS
    let kept = periods.filter((period) => (dayNumber(period.to) as number) >= cutoff)
    if (kept.length > MAX_TOTAL) kept = kept.slice(kept.length - MAX_TOTAL)
    io.write(JSON.stringify({ version: FILE_VERSION, periods: kept }, null, 2))
  }

  const byDate = (a: Period, b: Period) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.id.localeCompare(b.id)

  return {
    today,

    /** Every period, in the order of the dates. */
    list: (): Period[] => load().sort(byDate),

    listFor: (accountId: string): Period[] => load().filter((period) => period.accountId === accountId).sort(byDate),

    add(input: { accountId: string; from: unknown; to: unknown; note?: unknown }): Period {
      const periods = load()
      const from = dayNumber(input.from)
      const to = dayNumber(input.to)
      if (from === null || to === null) throw new AvailabilityError('invalid', 'Vul de eerste en de laatste dag in als datum.')
      if (to < from) throw new AvailabilityError('invalid', 'De laatste dag mag niet voor de eerste dag liggen.')
      if (to - from + 1 > MAX_SPAN_DAYS) throw new AvailabilityError('invalid', `Een periode is hoogstens ${MAX_SPAN_DAYS} dagen.`)
      const first = dayNumber(today()) as number
      if (to < first) throw new AvailabilityError('invalid', 'Deze periode is al voorbij.')
      if (from > first + MAX_AHEAD_DAYS) throw new AvailabilityError('invalid', 'Deze periode ligt te ver in de toekomst (hoogstens twee jaar vooruit).')
      const note = checkNote(input.note)
      if (note === null) throw new AvailabilityError('invalid', `De opmerking mag hoogstens ${MAX_NOTE} tekens zijn, op één regel.`)

      const own = periods.filter((period) => period.accountId === input.accountId)
      if (own.some((period) => (dayNumber(period.from) as number) <= to && (dayNumber(period.to) as number) >= from)) {
        throw new AvailabilityError('conflict', 'Deze periode overlapt met een periode die je al hebt doorgegeven. Verwijder die eerst of kies andere dagen.')
      }
      if (own.filter((period) => (dayNumber(period.to) as number) >= first).length >= MAX_PER_PERSON) {
        throw new AvailabilityError('limit', `Je hebt al ${MAX_PER_PERSON} periodes doorgegeven. Verwijder er eerst een.`)
      }
      const period: Period = {
        id: newId(), accountId: input.accountId,
        from: dateOf(from), to: dateOf(to), note, createdAt: now().toISOString(),
      }
      save([...periods, period])
      return period
    },

    /** Only the owner can remove a period; for anyone else it is as if it does not exist. */
    remove(id: string, accountId: string): Period {
      const periods = load()
      const period = periods.find((item) => item.id === id && item.accountId === accountId)
      if (!period) throw new AvailabilityError('not_found', 'Periode niet gevonden.')
      save(periods.filter((item) => item !== period))
      return period
    },

    /** For an account that is removed. */
    removeAllOf(accountId: string): void {
      const periods = load()
      if (periods.some((period) => period.accountId === accountId)) save(periods.filter((period) => period.accountId !== accountId))
    },
  }
}

export type AvailabilityStore = ReturnType<typeof createAvailabilityStore>
