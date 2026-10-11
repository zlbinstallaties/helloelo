import { validateCustomerFacts } from './documents/customer-facts.ts'
import type { CustomerFactValue } from './documents/customer-facts.ts'
import type { DocumentReference } from './gateway-document.ts'

/*
 * The dashboard's side of "fill in the schouw facts on the customer in Odoo": one call to the gateway action
 * `set_customer_facts`, and what its answer means. No server-only imports, so it is unit-tested in test/.
 *
 * Only a request id, a reference to the appointment and the facts (keys and values of `CUSTOMER_FACTS`) are sent. The customer
 * and the Odoo fields are never sent: the gateway reads the customer from the appointment and knows the fields itself.
 *
 * The answer is sorted by what it allows next:
 *   ok             written: facts that were filled in; kept: facts whose field already had a value (not overwritten).
 *   rejected       nothing was written; the message says why.
 *   not_enabled    the gateway refused at the door (action off for this token): nothing was written.
 *   not_installed  the fields do not exist in Odoo (the module `dig_schouw_facts` is not installed): nothing was written.
 *   unknown        no usable answer. Writing the same facts again does no harm (it only fills what is still empty).
 *
 * What goes wrong here never takes the document back: the document is already on the customer when this is called.
 */

export type SetCustomerFactsOutcome =
  | { ok: true; written: string[]; kept: string[]; customer: string | null; replayed: boolean }
  | { ok: false; kind: 'rejected' | 'not_enabled' | 'not_installed' | 'unknown'; message: string }

const UNKNOWN = 'Er kwam geen bruikbaar antwoord van Odoo. Het is niet zeker of de gegevens bij de klant zijn gezet.'
const PLAIN_REASON = /^(?:[A-Za-z_][\w.]{0,80}|upstream status \d{3})$/

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 60)

function interpret(status: number, body: unknown): SetCustomerFactsOutcome {
  const data = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const code = typeof data.error === 'string' ? data.error : ''
  const reason = typeof data.message === 'string' && PLAIN_REASON.test(data.message) ? ` (${data.message})` : ''
  const refused = (message: string): SetCustomerFactsOutcome => ({ ok: false, kind: 'rejected', message })

  if (status === 200) {
    if (!isStrings(data.written) || !isStrings(data.kept)) return { ok: false, kind: 'unknown', message: UNKNOWN }
    const customer = typeof data.customer === 'string' && data.customer.trim() ? data.customer.trim().slice(0, 120) : null
    return { ok: true, written: data.written, kept: data.kept, customer, replayed: data.replayed === true }
  }
  if (status === 403) return { ok: false, kind: 'not_enabled', message: 'Het invullen van gegevens bij de klant staat niet aan op de server.' }
  if (status === 401) return refused('Het gateway-token van het dashboard is niet geldig. Neem contact op met de beheerder.')
  if (status === 409 && code === 'fields_not_installed') {
    return { ok: false, kind: 'not_installed', message: 'De velden voor de schouwgegevens bestaan nog niet in Odoo (de module dig_schouw_facts is niet geïnstalleerd).' }
  }
  if (status === 404 && code === 'reference_not_found') return refused('De afspraak of de klant is in Odoo niet gevonden.')
  if (status === 409 && code === 'reference_has_no_customer') return refused('Bij deze afspraak staat in Odoo geen klant.')
  if (status === 429 && code === 'rate_limited') return refused('Er zijn te veel gegevens per uur doorgegeven. Probeer het later opnieuw.')
  if (status === 400) return refused(`De gateway heeft de gegevens geweigerd${PLAIN_REASON.test(code) ? ` (${code})` : ''}.`)
  if (status === 502 && code === 'odoo_rejected') return refused(`Odoo heeft de gegevens geweigerd${reason}.`)
  if ((status === 502 && code === 'odoo_error') || (status === 504 && code === 'odoo_timeout')) return refused('Odoo gaf een fout of reageerde niet.')
  // 504 outcome_unknown, 409 in_progress or request_id_reused, a proxy error, anything odd.
  return { ok: false, kind: 'unknown', message: UNKNOWN }
}

export async function setCustomerFactsViaGateway(options: {
  url: string
  token: string
  requestId: string
  reference: DocumentReference
  facts: Record<string, CustomerFactValue>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<SetCustomerFactsOutcome> {
  const { reference } = options
  // Whatever is wrong here is wrong before anything has been sent.
  if ((reference.model !== 'planning.slot' && reference.model !== 'svs.tech.visit') || !Number.isInteger(reference.id) || reference.id <= 0) {
    return { ok: false, kind: 'rejected', message: 'Deze afspraak hoort niet bij een planning of bezoek in Odoo.' }
  }
  const checked = validateCustomerFacts(options.facts)
  if (!checked.ok) return { ok: false, kind: 'rejected', message: 'De gegevens voor de klant zijn niet geldig.' }

  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('timeout')))
  })
  try {
    const call = (async () => {
      const response = await doFetch(new URL('/v1/actions/set_customer_facts', options.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: options.requestId, reference: { model: reference.model, id: reference.id }, facts: checked.facts }),
        signal: controller.signal,
      })
      const body = await response.json().catch(() => null)
      return { status: response.status, body }
    })()
    call.catch(() => {})
    const { status, body } = await Promise.race([call, expired])
    return interpret(status, body)
  } catch {
    return { ok: false, kind: 'unknown', message: UNKNOWN }
  } finally {
    clearTimeout(timer)
  }
}
