import type { AccountIo } from './accounts.ts'

/*
 * The journal of "add a technician" requests. It is written BEFORE Odoo is asked anything, and after each step,
 * so that a repeat of a request (a double click, a lost answer, a restart of the server) is recognised and never
 * makes a second employee in Odoo.
 *
 *   creating  Odoo is being asked (or was, and nobody wrote down the answer)
 *   created   Odoo confirmed the employee (employeeId); the portal account is not made yet
 *   done      employee and portal account both exist (accountId)
 *   unknown   it is not known whether Odoo created the employee: look in Odoo, do not try again
 *
 * A request that Odoo refused is removed again: nothing was created, so trying again is safe.
 * No passwords are ever written here. No I/O of its own (`AccountIo`), so it is unit-tested in test/.
 */

export type JournalState = 'creating' | 'created' | 'done' | 'unknown'

export type JournalEntry = {
  requestId: string
  state: JournalState
  name: string
  username: string
  /** The account (id) of the planner who asked. */
  by: string
  at: string
  updatedAt: string
  employeeId?: number
  /** Odoo confirmed the id, and reading it back confirmed no Odoo user and the right company. */
  verified?: boolean
  accountId?: string
}

export class JournalError extends Error {
  code: 'exists' | 'not_found' | 'state'

  constructor(code: 'exists' | 'not_found' | 'state', message: string) {
    super(message)
    this.name = 'JournalError'
    this.code = code
  }
}

export class JournalFileError extends Error {
  constructor(message: string) {
    super(`Het aanvragenbestand is ongeldig: ${message}`)
    this.name = 'JournalFileError'
  }
}

const FILE_VERSION = 1
const STATES: readonly JournalState[] = ['creating', 'created', 'done', 'unknown']
const KEEP_DONE_MS = 30 * 24 * 60 * 60_000
const MAX_ENTRIES = 1000

function parse(text: string | null): JournalEntry[] {
  if (text === null) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new JournalFileError('geen geldige JSON.')
  }
  const file = data as { version?: unknown; requests?: unknown } | null
  if (typeof file !== 'object' || file === null || Array.isArray(file) || file.version !== FILE_VERSION || !Array.isArray(file.requests)) {
    throw new JournalFileError(`verwacht { "version": ${FILE_VERSION}, "requests": [...] }.`)
  }
  const seen = new Set<string>()
  return file.requests.map((raw: unknown, index: number): JournalEntry => {
    const e = raw as Record<string, unknown>
    if (
      typeof e?.requestId !== 'string' || !e.requestId || !STATES.includes(e.state as JournalState) ||
      typeof e.name !== 'string' || typeof e.username !== 'string' || typeof e.by !== 'string' ||
      typeof e.at !== 'string' || typeof e.updatedAt !== 'string' ||
      (e.employeeId !== undefined && !(Number.isInteger(e.employeeId) && (e.employeeId as number) > 0)) ||
      (e.verified !== undefined && typeof e.verified !== 'boolean') ||
      (e.accountId !== undefined && typeof e.accountId !== 'string')
    ) {
      throw new JournalFileError(`aanvraag ${index + 1} mist een veld of heeft een onjuiste waarde.`)
    }
    if (seen.has(e.requestId)) throw new JournalFileError(`aanvraag ${index + 1}: dubbel id.`)
    seen.add(e.requestId)
    return e as unknown as JournalEntry
  })
}

export function createJournal(options: { io: AccountIo; now?: () => Date }) {
  const { io } = options
  const now = options.now ?? (() => new Date())

  const load = () => parse(io.read())

  function save(entries: JournalEntry[]) {
    // Finished requests older than 30 days are forgotten; open and unsure ones stay until someone has looked.
    const cutoff = now().getTime() - KEEP_DONE_MS
    let kept = entries.filter((entry) => entry.state !== 'done' || Date.parse(entry.updatedAt) >= cutoff)
    if (kept.length > MAX_ENTRIES) {
      let excess = kept.length - MAX_ENTRIES
      kept = kept.filter((entry) => !(entry.state === 'done' && excess-- > 0))
    }
    io.write(JSON.stringify({ version: FILE_VERSION, requests: kept }, null, 2))
  }

  function change(requestId: string, from: JournalState[], apply: (entry: JournalEntry) => void) {
    const entries = load()
    const entry = entries.find((item) => item.requestId === requestId)
    if (!entry) throw new JournalError('not_found', 'Aanvraag niet gevonden.')
    if (!from.includes(entry.state)) throw new JournalError('state', `Een aanvraag in de stand "${entry.state}" kan dit niet.`)
    apply(entry)
    entry.updatedAt = now().toISOString()
    save(entries)
    return entry
  }

  return {
    list: load,

    get(requestId: string): JournalEntry | undefined {
      return load().find((entry) => entry.requestId === requestId)
    },

    begin(input: { requestId: string; name: string; username: string; by: string }): JournalEntry {
      const entries = load()
      if (entries.some((entry) => entry.requestId === input.requestId)) throw new JournalError('exists', 'Deze aanvraag is al vastgelegd.')
      const at = now().toISOString()
      const entry: JournalEntry = { requestId: input.requestId, state: 'creating', name: input.name, username: input.username, by: input.by, at, updatedAt: at }
      save([...entries, entry])
      return entry
    },

    markCreated: (requestId: string, employeeId: number, verified = false) =>
      change(requestId, ['creating'], (entry) => {
        entry.state = 'created'
        entry.employeeId = employeeId
        entry.verified = verified
      }),

    /** While only the account is missing, another user name may be chosen. */
    setUsername: (requestId: string, username: string) =>
      change(requestId, ['created'], (entry) => {
        entry.username = username
      }),

    markDone: (requestId: string, accountId: string) =>
      change(requestId, ['created'], (entry) => {
        entry.state = 'done'
        entry.accountId = accountId
      }),

    /** `employeeId` when it is known that an employee exists but that it is not as it should be. */
    markUnknown: (requestId: string, employeeId?: number) =>
      change(requestId, ['creating'], (entry) => {
        entry.state = 'unknown'
        if (employeeId !== undefined) entry.employeeId = employeeId
      }),

    /** Only a request that created nothing can be removed. */
    remove(requestId: string): void {
      const entries = load()
      const entry = entries.find((item) => item.requestId === requestId)
      if (!entry) throw new JournalError('not_found', 'Aanvraag niet gevonden.')
      if (entry.state !== 'creating') throw new JournalError('state', `Een aanvraag in de stand "${entry.state}" kan niet worden verwijderd.`)
      save(entries.filter((item) => item.requestId !== requestId))
    },
  }
}

export type Journal = ReturnType<typeof createJournal>
