import { buildAppointments } from './appointments.ts'
import { visibleAppointments } from './authorization.ts'
import type { User } from './authorization.ts'
import type { DashboardAppointment } from './dashboard-types.ts'
import { DocumentJournalError } from './document-journal.ts'
import type { DocumentEntry, DocumentJournal } from './document-journal.ts'
import { FORMS, isDocumentType } from './documents/forms.ts'
import { DocumentRenderError, documentFilename, documentSummary, renderDocumentPdf } from './documents/render.ts'
import { validateSubmission } from './documents/submission.ts'
import { accountFileProblem, fail, json, readJsonBody, unknownField } from './http.ts'
import type { Context } from './handlers.ts'
import { AccountsFileError } from './accounts.ts'
import type { DocumentReference } from './gateway-document.ts'
import { DocumentJournalFileError } from './document-journal.ts'

/*
 * Sending a filled-in schouw or oplever document: the technician (or the planner) fills it in, the customer signs on the
 * screen, and the signed PDF is put on that customer in Odoo through the gateway. Every request is checked on the server:
 *
 * - who sends it comes from the session. The author in the PDF is the logged-in person; a request cannot name one;
 * - a technician can send for his OWN appointments only (the planner for every appointment); another appointment looks
 *   like it does not exist;
 * - the customer is never chosen here: only the appointment is named, and the gateway reads the customer of that
 *   record from Odoo;
 * - the form is checked again with the same rules as on the phone (`validateSubmission`), and the PDF is made here;
 * - the submission number makes a repeat harmless: the same document is never put on the customer twice, and when it is
 *   not known whether it arrived it is NOT sent again unless the person starts a new submission on purpose.
 *
 * With logins off none of this exists: a document has an author. Nothing of a document is kept here: only the journal
 * (which appointment, what kind, who, when, and the result).
 */

/** Photos make a document big: the biggest honest request is about 9 million characters. */
export const DOCUMENT_BODY_CHARS = 10 * 1024 * 1024

const APPOINTMENT_ID = /^(?:slot|visit)-[1-9][0-9]{0,9}$/
const SUBMISSION_ID = /^[A-Za-z0-9-]{16,64}$/
const FIELDS = ['type', 'appointmentId', 'submissionId', 'answers', 'signature']

const WAIT = 'Dit document wordt nog verstuurd. Wacht even en kijk dan bij de klant in Odoo; verstuur het niet nog een keer.'
const NOT_SURE = 'Het is niet zeker of dit document bij de klant in Odoo staat. Controleer dat in Odoo voordat je het opnieuw verstuurt; een tweede keer versturen kan een dubbel document geven.'
const REUSED = 'Dit documentnummer is al voor een ander document gebruikt.'

/** The customer as one plain line of at most 120 characters, for the file name and the note. */
export function cleanCustomer(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 120).trim() : ''
  return text || 'Klant'
}

/** The record the customer is read from: the planning if there is one, otherwise the visit. */
function referenceOf(appointment: DashboardAppointment): DocumentReference | null {
  if (appointment.slotId !== null) return { model: 'planning.slot', id: appointment.slotId }
  if (appointment.visitId !== null) return { model: 'svs.tech.visit', id: appointment.visitId }
  return null
}

export function createDocumentHandlers(ctx: Context) {
  const { deps } = ctx
  const now = deps.now ?? (() => new Date())

  type Opened = { ok: true; user: User; journal: DocumentJournal } | { ok: false; response: Response }

  function open(request: Request): Opened {
    if (deps.authMode === 'off') return { ok: false, response: fail(404, 'Documenten versturen kan niet: inloggen staat uit.') }
    const guard = ctx.guard(request)
    if (!guard.ok) return guard
    if (!deps.accounts || !deps.documents) return { ok: false, response: fail(503, 'Inloggen is niet ingesteld op de server.') }
    return { ok: true, user: guard.user, journal: deps.documents }
  }

  /** What a submission that was already seen means for this request. `null`: it is new. */
  function replay(entry: DocumentEntry, user: User, type: string, appointmentId: string): Response | null {
    if (entry.by !== user.id || entry.type !== type || entry.appointmentId !== appointmentId) return fail(409, REUSED)
    if (entry.state === 'posted') return json({ ok: true, state: 'posted', noted: entry.noted === true, customer: null, replayed: true })
    if (entry.state === 'sending') return fail(409, WAIT)
    return json({ error: NOT_SURE, retry: false }, 409)
  }

  return {
    /** POST /api/documents {type, appointmentId, submissionId, answers, signature}: puts the signed PDF on the customer in Odoo. */
    async documentsPost(request: Request): Promise<Response> {
      try {
        const opened = open(request)
        if (!opened.ok) return opened.response
        const { user, journal } = opened
        const read = await readJsonBody(request, DOCUMENT_BODY_CHARS)
        if (!read.ok) return read.response
        const unknown = unknownField(read.body, FIELDS)
        if (unknown) return unknown

        const { type, appointmentId, submissionId } = read.body
        if (!isDocumentType(type)) return fail(400, 'Onbekend soort document.')
        if (typeof appointmentId !== 'string' || !APPOINTMENT_ID.test(appointmentId)) return fail(400, 'Ongeldige afspraak.')
        if (typeof submissionId !== 'string' || !SUBMISSION_ID.test(submissionId)) return fail(400, 'Ongeldig documentnummer.')

        // A repeat of a document that was already sent is answered from the journal; the gateway is not asked again.
        const seen = journal.settle(submissionId)
        if (seen) return replay(seen, user, type, appointmentId) as Response

        let data
        try {
          data = await deps.loadData(false)
        } catch (error) {
          return fail(502, error instanceof Error ? error.message : 'Odoo kon niet worden gelezen.')
        }
        const appointment = visibleAppointments(user, buildAppointments(data, deps.odooBaseUrl)).find((item) => item.id === appointmentId)
        if (!appointment) return fail(404, 'Afspraak niet gevonden.')
        const reference = referenceOf(appointment)
        if (!reference) return fail(409, 'Deze afspraak heeft geen planning of bezoek in Odoo, dus het document kan nergens bij.')

        const form = FORMS[type]
        const checked = validateSubmission(form, { author: user.name, answers: read.body.answers, signature: read.body.signature })
        if (!checked.ok) return json({ error: 'Controleer het formulier.', errors: checked.errors }, 422)

        const createdAt = now()
        const customer = cleanCustomer(appointment.customer)
        let pdf: Uint8Array
        try {
          pdf = renderDocumentPdf(
            form,
            {
              companyName: data.company.name, customer, address: appointment.address, appointmentTitle: appointment.title,
              appointmentDate: appointment.visitDate, people: appointment.people.map((person) => person.name), createdAt,
            },
            checked.value,
          )
        } catch (error) {
          if (error instanceof DocumentRenderError) return fail(422, error.message)
          throw error
        }

        let entry: DocumentEntry
        try {
          entry = journal.begin({ submissionId, type, appointmentId, by: user.id })
        } catch (error) {
          // Another request with the same number got here first.
          if (error instanceof DocumentJournalError && error.code === 'exists') return fail(409, WAIT)
          throw error
        }

        const outcome = await deps.postDocument({
          requestId: entry.requestId, reference, filename: documentFilename(form, customer, createdAt), summary: documentSummary(form, customer, createdAt), pdf,
        })
        if (outcome.ok) {
          journal.markPosted(submissionId, outcome.noted)
          return json({ ok: true, state: 'posted', noted: outcome.noted, customer: outcome.customer, replayed: outcome.replayed })
        }
        if (outcome.kind === 'unknown') {
          journal.markUnknown(submissionId)
          return json({ error: outcome.message, retry: false }, 504)
        }
        // Nothing was placed: the number is free again, so the same document can be sent once more.
        journal.remove(submissionId)
        return outcome.kind === 'not_enabled' ? json({ error: outcome.message, retry: false }, 503) : json({ error: outcome.message, retry: true }, 502)
      } catch (error) {
        if (error instanceof AccountsFileError) return accountFileProblem()
        if (error instanceof DocumentJournalFileError) return fail(500, 'Het documentenbestand is ongeldig; neem contact op met de beheerder.')
        throw error
      }
    },
  }
}
