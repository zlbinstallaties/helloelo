/*
 * The dashboard's side of "put a signed document on the customer in Odoo": one call to the gateway action
 * `post_document`, and what its answer means. No server-only imports, so it is unit-tested in test/.
 *
 * Only a request id, a reference to the appointment (a planning.slot or svs.tech.visit), the file name, a one-line
 * summary and the PDF are sent. The customer is never sent: the gateway reads it from the reference record in
 * Odoo, so nothing from a phone can pick another customer.
 *
 * The answer is sorted by what it allows next:
 *   ok           the file is on the customer (`noted`: the note in the chatter is there too).
 *   rejected     nothing was placed; trying again is safe.
 *   not_enabled  the gateway refused at the door (action off for this token): nothing was placed.
 *   unknown      no usable answer: the file may be there, so do NOT try again, look at the customer in Odoo.
 */

export type DocumentReference = { model: 'planning.slot' | 'svs.tech.visit'; id: number }

export type PostDocumentOutcome =
  | { ok: true; /** The note with the file in the chatter of the customer is there too. */ noted: boolean; /** The name of the customer, as Odoo has it. */ customer: string | null; replayed: boolean }
  | { ok: false; kind: 'rejected' | 'not_enabled' | 'unknown'; message: string }

/** What the gateway accepts: a PDF of at most 8 MB. */
export const MAX_PDF_BYTES = 8 * 1024 * 1024

const UNKNOWN = 'Er kwam geen bruikbaar antwoord van Odoo. Het is niet zeker of het document bij de klant staat: controleer dat in Odoo voordat je het opnieuw verstuurt.'
const TOKEN = 'Het gateway-token van het dashboard is niet geldig. Neem contact op met de beheerder. Er is niets geplaatst.'
// Free text of Odoo can contain names or addresses; only a plain class name or status is passed on.
const PLAIN_REASON = /^(?:[A-Za-z_][\w.]{0,80}|upstream status \d{3})$/

function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function interpret(status: number, body: unknown): PostDocumentOutcome {
  const data = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const code = typeof data.error === 'string' ? data.error : ''
  const reason = typeof data.message === 'string' && PLAIN_REASON.test(data.message) ? ` (${data.message})` : ''
  const refused = (message: string): PostDocumentOutcome => ({ ok: false, kind: 'rejected', message })

  if (status === 200) {
    if (!isId(data.id)) return { ok: false, kind: 'unknown', message: UNKNOWN }
    const customer = typeof data.customer === 'string' && data.customer.trim() ? data.customer.trim().slice(0, 120) : null
    return { ok: true, noted: data.noted === true, customer, replayed: data.replayed === true }
  }
  if (status === 403) return { ok: false, kind: 'not_enabled', message: 'Het versturen van documenten naar Odoo staat niet aan op de server. Neem contact op met de beheerder.' }
  if (status === 401) return refused(TOKEN)
  if (status === 404 && code === 'reference_not_found') return refused('Deze afspraak is in Odoo niet gevonden (misschien verwijderd of van een ander bedrijf). Er is niets geplaatst.')
  if (status === 409 && code === 'reference_has_no_customer') return refused('Bij deze afspraak staat in Odoo geen klant, dus het document kan nergens bij. Vraag de planner de klant bij de afspraak te zetten. Er is niets geplaatst.')
  if (status === 429 && code === 'rate_limited') return refused('Er zijn te veel documenten per uur verstuurd. Probeer het later opnieuw; er is niets geplaatst.')
  if (status === 413) return refused('Het document is te groot voor Odoo (maximaal 8 MB). Gebruik minder of kleinere foto\'s. Er is niets geplaatst.')
  if (status === 400) return refused(`De gateway heeft het document geweigerd${PLAIN_REASON.test(code) ? ` (${code})` : ''}. Er is niets geplaatst.`)
  if (status === 502 && code === 'odoo_rejected') return refused(`Odoo heeft het document geweigerd${reason}. Er is niets geplaatst.`)
  // Odoo could not be read before anything was written (these codes only come from the read): nothing was placed.
  if ((status === 502 && code === 'odoo_error') || (status === 504 && code === 'odoo_timeout')) {
    return refused('Odoo gaf een fout of reageerde niet. Er is niets geplaatst; probeer het zo opnieuw.')
  }
  // 504/409 outcome_unknown, 409 in_progress or request_id_reused, a proxy error, anything odd.
  return { ok: false, kind: 'unknown', message: UNKNOWN }
}

export async function postDocumentViaGateway(options: {
  url: string
  token: string
  requestId: string
  reference: DocumentReference
  filename: string
  summary: string
  pdf: Uint8Array
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<PostDocumentOutcome> {
  const { reference, pdf } = options
  // Whatever is wrong here is wrong before anything has been sent.
  if ((reference.model !== 'planning.slot' && reference.model !== 'svs.tech.visit') || !isId(reference.id)) {
    return { ok: false, kind: 'rejected', message: 'Deze afspraak hoort niet bij een planning of bezoek in Odoo. Er is niets geplaatst.' }
  }
  if (pdf.length > MAX_PDF_BYTES) {
    return { ok: false, kind: 'rejected', message: 'Het document is te groot voor Odoo (maximaal 8 MB). Gebruik minder of kleinere foto\'s. Er is niets geplaatst.' }
  }
  if (!(pdf.length > 8 && Buffer.from(pdf.subarray(0, 5)).toString('latin1') === '%PDF-')) {
    return { ok: false, kind: 'rejected', message: 'Het document is geen geldige PDF. Er is niets geplaatst.' }
  }

  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('timeout')))
  })
  try {
    const call = (async () => {
      const response = await doFetch(new URL('/v1/actions/post_document', options.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: options.requestId,
          reference: { model: reference.model, id: reference.id },
          filename: options.filename,
          summary: options.summary,
          pdf: Buffer.from(pdf).toString('base64'),
        }),
        signal: controller.signal,
      })
      const body = await response.json().catch(() => null)
      return { status: response.status, body }
    })()
    call.catch(() => {})
    const { status, body } = await Promise.race([call, expired])
    return interpret(status, body)
  } catch {
    // The call may have reached the gateway and Odoo before it failed: the outcome is open.
    return { ok: false, kind: 'unknown', message: UNKNOWN }
  } finally {
    clearTimeout(timer)
  }
}
