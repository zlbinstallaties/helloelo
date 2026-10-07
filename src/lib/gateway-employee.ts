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
  | { kind: 'created'; id: number; verified: boolean; /** How many of the configured planning roles Odoo confirmed on the employee. */ planningRoles: number; replayed: boolean }
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
    const roles = Number.isInteger(data.planningRoles) && (data.planningRoles as number) >= 0 && (data.planningRoles as number) <= 99 ? (data.planningRoles as number) : 0
    return { kind: 'created', id: data.id, verified: data.verified === true, planningRoles: roles, replayed: data.replayed === true }
  }
  if (status === 401) return { kind: 'not_enabled', message: 'Het gateway-token van het dashboard is niet geldig. Neem contact op met de beheerder.' }
  if (status === 403) return { kind: 'not_enabled', message: 'Het aanmaken van monteurs in Odoo staat niet aan op de server. Neem contact op met de beheerder.' }
  if (status === 409 && code === 'responsible_not_allowed') {
    return { kind: 'rejected', message: 'De ingestelde verantwoordelijke in Odoo is niet geldig (niet actief, geen interne gebruiker of niet van het bedrijf). Neem contact op met de beheerder; er is niets aangemaakt.' }
  }
  if (status === 409 && code === 'planning_role_not_allowed') {
    return { kind: 'rejected', message: 'De ingestelde planningsrol bestaat niet (meer) in Odoo of is gearchiveerd. Neem contact op met de beheerder; er is niets aangemaakt.' }
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
  /** `planning.role` ids the planner chose; sent only when there are any. */
  planningRoleIds?: readonly number[]
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
        body: JSON.stringify({ requestId: options.requestId, name: options.name, ...(options.planningRoleIds && options.planningRoleIds.length > 0 && { planningRoleIds: options.planningRoleIds }) }),
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

export type PlanningRole = { id: number; name: string }
export type PlanningRolesOutcome = { ok: true; roles: PlanningRole[] } | { ok: false; message: string }

/** The planning roles a planner can give a new employee, read through the gateway (which reads them from Odoo). */
export async function listPlanningRolesViaGateway(options: { url: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<PlanningRolesOutcome> {
  const doFetch = options.fetchImpl ?? fetch
  try {
    const response = await doFetch(new URL('/v1/planning-roles', options.url), {
      method: 'GET',
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
    const body = (await response.json().catch(() => null)) as { roles?: unknown } | null
    if (response.status === 401) return { ok: false, message: 'Het gateway-token van het dashboard is niet geldig. Neem contact op met de beheerder.' }
    if (response.status === 403) return { ok: false, message: 'Het aanmaken van monteurs in Odoo staat niet aan op de server. Neem contact op met de beheerder.' }
    if (response.status !== 200 || !Array.isArray(body?.roles)) return { ok: false, message: 'De planningsrollen konden niet uit Odoo worden gelezen. Probeer het zo opnieuw.' }
    const roles = (body.roles as unknown[])
      .map((role) => role as { id?: unknown; name?: unknown })
      .filter((role): role is PlanningRole => isId(role?.id) && typeof role.name === 'string' && role.name.trim() !== '')
      .map((role) => ({ id: role.id, name: role.name }))
    return { ok: true, roles }
  } catch {
    return { ok: false, message: 'De planningsrollen konden niet uit Odoo worden gelezen. Probeer het zo opnieuw.' }
  }
}

/** What the gateway answers about the planning roles of ONE employee. `notFound`: Odoo has no active employee with this id. */
export type EmployeeRolesOutcome =
  | { ok: true; planningRoleIds: number[]; defaultPlanningRoleId: number | null }
  | { ok: false; message: string; notFound?: boolean }

export type SetRolesOutcome =
  | { ok: true; planningRoles: number; asked: number }
  | { ok: false; message: string; notFound?: boolean }

const NOT_ENABLED_ROLES = 'Het wijzigen van planningsrollen staat niet aan op de server. Neem contact op met de beheerder.'
const TOKEN_INVALID = 'Het gateway-token van het dashboard is niet geldig. Neem contact op met de beheerder.'

async function callGateway(options: { url: string; token: string; path: string; method: 'GET' | 'POST'; body?: unknown; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const response = await (options.fetchImpl ?? fetch)(new URL(options.path, options.url), {
    method: options.method,
    headers: { authorization: `Bearer ${options.token}`, ...(options.body !== undefined && { 'content-type': 'application/json' }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  return { status: response.status, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} }
}

/** The planning roles the employee has in Odoo now, and his default role. */
export async function readEmployeeRolesViaGateway(options: { url: string; token: string; employeeId: number; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<EmployeeRolesOutcome> {
  if (!isId(options.employeeId)) return { ok: false, message: 'Dit account hangt niet aan een medewerker in Odoo.' }
  try {
    const { status, data } = await callGateway({ ...options, path: `/v1/employees/${options.employeeId}/planning-roles`, method: 'GET' })
    if (status === 401) return { ok: false, message: TOKEN_INVALID }
    if (status === 403) return { ok: false, message: NOT_ENABLED_ROLES }
    if (status === 404 && data.error === 'employee_not_found') return { ok: false, notFound: true, message: 'Deze medewerker bestaat niet (meer) in Odoo, of is gearchiveerd.' }
    if (status !== 200 || !Array.isArray(data.planningRoleIds) || !data.planningRoleIds.every(isId)) {
      return { ok: false, message: 'De planningsrollen van deze medewerker konden niet uit Odoo worden gelezen. Probeer het zo opnieuw.' }
    }
    return { ok: true, planningRoleIds: [...(data.planningRoleIds as number[])], defaultPlanningRoleId: isId(data.defaultPlanningRoleId) ? data.defaultPlanningRoleId : null }
  } catch {
    return { ok: false, message: 'De planningsrollen van deze medewerker konden niet uit Odoo worden gelezen. Probeer het zo opnieuw.' }
  }
}

/** Sets the planning roles of one employee (the first is the default). Setting the same roles twice is harmless, so a repeat is always allowed. */
export async function setEmployeeRolesViaGateway(options: { url: string; token: string; employeeId: number; planningRoleIds: readonly number[]; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<SetRolesOutcome> {
  if (!isId(options.employeeId)) return { ok: false, message: 'Dit account hangt niet aan een medewerker in Odoo.' }
  try {
    const { status, data } = await callGateway({ ...options, path: '/v1/actions/set_employee_planning_roles', method: 'POST', body: { employeeId: options.employeeId, planningRoleIds: options.planningRoleIds } })
    if (status === 200 && isId(data.id) && Number.isInteger(data.planningRoles) && Number.isInteger(data.asked)) {
      return { ok: true, planningRoles: data.planningRoles as number, asked: data.asked as number }
    }
    if (status === 401) return { ok: false, message: TOKEN_INVALID }
    if (status === 403) return { ok: false, message: NOT_ENABLED_ROLES }
    if (status === 404 && data.error === 'employee_not_found') return { ok: false, notFound: true, message: 'Deze medewerker bestaat niet (meer) in Odoo, of is gearchiveerd. Er is niets gewijzigd.' }
    if (status === 409 && data.error === 'planning_role_not_allowed') return { ok: false, message: 'Een gekozen planningsrol bestaat niet (meer) in Odoo, is gearchiveerd of is niet toegestaan. Er is niets gewijzigd.' }
    if (status === 429) return { ok: false, message: 'Er zijn te veel wijzigingen per uur gedaan. Probeer het later opnieuw; er is niets gewijzigd.' }
    if (status === 400) return { ok: false, message: `De gateway heeft het verzoek geweigerd${typeof data.error === 'string' && PLAIN_REASON.test(data.error) ? ` (${data.error})` : ''}. Er is niets gewijzigd.` }
    if (status === 502 && data.error === 'odoo_rejected') return { ok: false, message: 'Odoo heeft het wijzigen geweigerd. Er is niets gewijzigd.' }
    // A time-out or an odd answer: the roles may or may not have changed; sending it again sets the same roles.
    return { ok: false, message: 'Er kwam geen bruikbaar antwoord van Odoo. Open de medewerker in Odoo om te zien welke rollen hij heeft, of probeer het opnieuw: dat zet dezelfde rollen nog eens.' }
  } catch {
    return { ok: false, message: 'Er kwam geen bruikbaar antwoord van Odoo. Open de medewerker in Odoo om te zien welke rollen hij heeft, of probeer het opnieuw: dat zet dezelfde rollen nog eens.' }
  }
}
