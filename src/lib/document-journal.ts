import { createHash } from 'node:crypto'
import type { AccountIo } from './accounts.ts'
import { isDocumentType } from './documents/forms.ts'
import type { DocumentType } from './documents/forms.ts'

/*
 * The journal of documents that are put on a customer in Odoo. It is written BEFORE the gateway is asked anything,
 * and after the answer, so that a repeat of the same submission (a double tap, a lost answer on a bad connection,
 * a restart of the server) is recognised and never puts a second file on the customer.
 *
 *   sending   the gateway is being asked (or was, and nobody wrote down the answer)
 *   posted    Odoo confirmed the file on the customer (`noted`: the note in the chatter is there too)
 *   unknown   it is not known whether the file was placed: look at the customer in Odoo, do not send it again
 *
 * A submission that was refused is removed again: nothing was placed, so trying again is safe.
 * Nothing of the document is kept: no answers, no photos, no signature, no file, no customer. Only which
 * appointment, which kind of document, who sent it and when. No I/O of its own (`AccountIo`), so it is unit-tested.
 */

export type DocumentState = 'sending' | 'posted' | 'unknown'

export type DocumentEntry = {
  /** Made by the phone for ONE filled-in document; a repeat of the same document has the same one. */
  submissionId: string
  /** What the gateway gets as request id (derived from the submission id; see `requestIdFor`). */
  requestId: string
  state: DocumentState
  type: DocumentType
  /** `slot-12` or `visit-5`: the appointment of the dashboard. */
  appointmentId: string
  /** The account (id) of the person who sent it. */
  by: string
  at: string
  updatedAt: string
  noted?: boolean
}

export class DocumentJournalError extends Error {
  code: 'exists' | 'not_found' | 'state'

  constructor(code: 'exists' | 'not_found' | 'state', message: string) {
    super(message)
    this.name = 'DocumentJournalError'
    this.code = code
  }
}

export class DocumentJournalFileError extends Error {
  constructor(message: string) {
    super(`Het documentenbestand is ongeldig: ${message}`)
    this.name = 'DocumentJournalFileError'
  }
}

const FILE_VERSION = 1
const STATES: readonly DocumentState[] = ['sending', 'posted', 'unknown']
const KEEP_POSTED_MS = 30 * 24 * 60 * 60_000
const MAX_ENTRIES = 2000
/** The gateway gives up after two minutes; an entry that is still "sending" after this long has no answer coming. */
const STALE_SENDING_MS = 5 * 60_000

/** The request id for the gateway: letters, digits and dashes, 16 to 64 long, and the same for the same submission. */
export function requestIdFor(submissionId: string): string {
  return `doc-${createHash('sha256').update(submissionId).digest('hex').slice(0, 40)}`
}

function parse(text: string | null): DocumentEntry[] {
  if (text === null) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new DocumentJournalFileError('geen geldige JSON.')
  }
  const file = data as { version?: unknown; documents?: unknown } | null
  if (typeof file !== 'object' || file === null || Array.isArray(file) || file.version !== FILE_VERSION || !Array.isArray(file.documents)) {
    throw new DocumentJournalFileError(`verwacht { "version": ${FILE_VERSION}, "documents": [...] }.`)
  }
  const seen = new Set<string>()
  return file.documents.map((raw: unknown, index: number): DocumentEntry => {
    const e = raw as Record<string, unknown>
    if (
      typeof e?.submissionId !== 'string' || !e.submissionId || typeof e.requestId !== 'string' || !e.requestId ||
      !STATES.includes(e.state as DocumentState) || !isDocumentType(e.type) ||
      typeof e.appointmentId !== 'string' || typeof e.by !== 'string' || typeof e.at !== 'string' || typeof e.updatedAt !== 'string' ||
      (e.noted !== undefined && typeof e.noted !== 'boolean')
    ) {
      throw new DocumentJournalFileError(`document ${index + 1} mist een veld of heeft een onjuiste waarde.`)
    }
    if (seen.has(e.submissionId)) throw new DocumentJournalFileError(`document ${index + 1}: dubbel id.`)
    seen.add(e.submissionId)
    return e as unknown as DocumentEntry
  })
}

export function createDocumentJournal(options: { io: AccountIo; now?: () => Date }) {
  const { io } = options
  const now = options.now ?? (() => new Date())

  const load = () => parse(io.read())

  function save(entries: DocumentEntry[]) {
    // Posted documents older than 30 days are forgotten; open and unsure ones stay until someone has looked.
    const cutoff = now().getTime() - KEEP_POSTED_MS
    let kept = entries.filter((entry) => entry.state !== 'posted' || Date.parse(entry.updatedAt) >= cutoff)
    if (kept.length > MAX_ENTRIES) {
      let excess = kept.length - MAX_ENTRIES
      kept = kept.filter((entry) => !(entry.state === 'posted' && excess-- > 0))
    }
    io.write(JSON.stringify({ version: FILE_VERSION, documents: kept }, null, 2))
  }

  function change(submissionId: string, from: DocumentState[], apply: (entry: DocumentEntry) => void) {
    const entries = load()
    const entry = entries.find((item) => item.submissionId === submissionId)
    if (!entry) throw new DocumentJournalError('not_found', 'Document niet gevonden.')
    if (!from.includes(entry.state)) throw new DocumentJournalError('state', `Een document in de stand "${entry.state}" kan dit niet.`)
    apply(entry)
    entry.updatedAt = now().toISOString()
    save(entries)
    return entry
  }

  return {
    list: load,

    get(submissionId: string): DocumentEntry | undefined {
      return load().find((entry) => entry.submissionId === submissionId)
    },

    /** Like `get`, but an entry that has been "sending" for too long becomes "unknown" first. */
    settle(submissionId: string): DocumentEntry | undefined {
      const entry = load().find((item) => item.submissionId === submissionId)
      if (!entry || entry.state !== 'sending' || now().getTime() - Date.parse(entry.updatedAt) < STALE_SENDING_MS) return entry
      return change(submissionId, ['sending'], (item) => {
        item.state = 'unknown'
      })
    },

    begin(input: { submissionId: string; type: DocumentType; appointmentId: string; by: string }): DocumentEntry {
      const entries = load()
      if (entries.some((entry) => entry.submissionId === input.submissionId)) throw new DocumentJournalError('exists', 'Dit document is al vastgelegd.')
      const at = now().toISOString()
      const entry: DocumentEntry = {
        submissionId: input.submissionId, requestId: requestIdFor(input.submissionId), state: 'sending',
        type: input.type, appointmentId: input.appointmentId, by: input.by, at, updatedAt: at,
      }
      save([...entries, entry])
      return entry
    },

    markPosted: (submissionId: string, noted: boolean) =>
      change(submissionId, ['sending'], (entry) => {
        entry.state = 'posted'
        entry.noted = noted
      }),

    markUnknown: (submissionId: string) =>
      change(submissionId, ['sending'], (entry) => {
        entry.state = 'unknown'
      }),

    /** Only a submission that placed nothing can be removed. */
    remove(submissionId: string): void {
      const entries = load()
      const entry = entries.find((item) => item.submissionId === submissionId)
      if (!entry) throw new DocumentJournalError('not_found', 'Document niet gevonden.')
      if (entry.state !== 'sending') throw new DocumentJournalError('state', `Een document in de stand "${entry.state}" kan niet worden verwijderd.`)
      save(entries.filter((item) => item.submissionId !== submissionId))
    },
  }
}

export type DocumentJournal = ReturnType<typeof createDocumentJournal>
