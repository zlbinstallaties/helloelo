/*
 * Small helpers for the request handlers: answers that are never cached, and reading a JSON body with limits.
 * Standard Request and Response only, so the handlers can be unit-tested without a server.
 */

const MAX_BODY_CHARS = 16 * 1024

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

export const fail = (status: number, error: string) => json({ error }, status)

export const accountFileProblem = () => fail(500, 'Het accountbestand is ongeldig; neem contact op met de beheerder.')

/**
 * The body as a JSON object, or the answer to send back instead. `limit` is in characters; a request that says it is
 * bigger is refused before its body is read.
 */
export async function readJsonBody(request: Request, limit = MAX_BODY_CHARS): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return { ok: false, response: fail(415, 'Het verzoek moet JSON zijn.') }
  }
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return { ok: false, response: fail(413, 'Het verzoek is te groot.') }
  const text = await request.text()
  if (text.length > limit) return { ok: false, response: fail(413, 'Het verzoek is te groot.') }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, response: fail(400, 'Ongeldige JSON.') }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: fail(400, 'Ongeldige JSON: een object werd verwacht.') }
  }
  return { ok: true, body: parsed as Record<string, unknown> }
}

/** The answer to send when the body has a field that is not in the list; null when every field is allowed. */
export function unknownField(body: Record<string, unknown>, allowed: readonly string[]): Response | null {
  const extra = Object.keys(body).find((key) => !allowed.includes(key))
  return extra === undefined ? null : fail(400, `Onbekend veld: ${extra}.`)
}
