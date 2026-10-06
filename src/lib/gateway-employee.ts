/*
 * The dashboard's side of "create a technician as an Odoo employee": one call to the gateway action
 * `create_employee`, and what its answer means. No server-only imports, so it is unit-tested in test/.
 *
 * Only the request id and the name are sent. Company, the Odoo user who is responsible, the values and the model
 * are fixed in the gateway; nothing from the browser can reach them.
 *
 * The answer is sorted by what it allows next:
 *   created      Odoo confirmed the employee (id).
 *   rejected     nothing was created; trying again is safe.
 *   not_enabled  the gateway refused at the door (action off for this token): nothing was created.
 *   unknown      no usable answer: the employee may exist, so do NOT try again, look in Odoo.
 *   invariant    an employee was created but is not as intended (has an Odoo user, other company): look in Odoo.
 */

export type GatewayOutcome =
  | { kind: 'created'; id: number; verified: boolean; replayed: boolean }
  | { kind: 'rejected'; message: string }
  | { kind: 'not_enabled'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'invariant'; id: number; message: string }

const UNKNOWN = 'Er kwam geen bruikbaar antwoord van Odoo. Het is niet zeker of de medewerker is aangemaakt: controleer dat in Odoo voordat je het opnieuw probeert.'
// Free text of Odoo can contain names or addresses; only a plain class name or status is passed on.
const PLAIN_REASON = /^(?:[A-Za-z_][\w.]{0,80}|upstream status \d{3})$/

function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function interpret(status: number, body: unknown): GatewayOutcome {
  const data = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const code = typeof data.error === 'string' ? data.error : ''
  const reason = typeof data.message === 'string' && PLAIN_REASON.test(data.message) ? ` (${data.message})` : ''

  if (status === 200) {
    if (!isId(data.id)) return { kind: 'unknown', message: UNKNOWN }
    return { kind: 'created', id: data.id, verified: data.verified === true, replayed: data.replayed === true }
  }
  if (status === 401) return { kind: 'not_enabled', message: 'Het gateway-token van het dashboard is niet geldig. Neem contact op met de beheerder.' }
  if (status === 403) return { kind: 'not_enabled', message: 'Het aanmaken van monteurs in Odoo staat niet aan op de server. Neem contact op met de beheerder.' }
  if (status === 409 && code === 'responsible_not_allowed') {
    return { kind: 'rejected', message: 'De ingestelde verantwoordelijke in Odoo is niet geldig (niet actief, geen interne gebruiker of niet van het bedrijf). Neem contact op met de beheerder; er is niets aangemaakt.' }
  }
  if (status === 429 && code === 'rate_limited') return { kind: 'rejected', message: 'Er zijn te veel monteurs per uur aangemaakt. Probeer het later opnieuw; er is niets aangemaakt.' }
  if (status === 502 && code === 'odoo_rejected') return { kind: 'rejected', message: `Odoo heeft het aanmaken geweigerd${reason}. Er is niets aangemaakt.` }
  if ((status === 502 && code === 'odoo_error') || (status === 504 && code === 'odoo_timeout')) {
    return { kind: 'rejected', message: 'Odoo reageerde niet of gaf een fout. Er is niets aangemaakt; probeer het zo opnieuw.' }
  }
  if (status === 400) return { kind: 'rejected', message: `De gateway heeft het verzoek geweigerd${code ? ` (${code})` : ''}. Er is niets aangemaakt.` }
  if (status === 500 && code === 'employee_invariant_violated') {
    const details = data.details as { id?: unknown } | undefined
    if (isId(details?.id)) {
      return { kind: 'invariant', id: details.id, message: `In Odoo is medewerker ${details.id} aangemaakt, maar niet zoals bedoeld (met een Odoo-gebruiker of in een ander bedrijf). Controleer en herstel dat in Odoo; er is geen account gemaakt.` }
    }
  }
  // 504/409 outcome_unknown, 409 in_progress or request_id_reused, a proxy error, anything odd.
  return { kind: 'unknown', message: UNKNOWN }
}

export async function createEmployeeViaGateway(options: {
  url: string
  token: string
  requestId: string
  name: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<GatewayOutcome> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000)
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('timeout')))
  })
  try {
    const call = (async () => {
      const response = await doFetch(new URL('/v1/actions/create_employee', options.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: options.requestId, name: options.name }),
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
    return { kind: 'unknown', message: UNKNOWN }
  } finally {
    clearTimeout(timer)
  }
}
