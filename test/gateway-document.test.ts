import test from 'node:test'
import assert from 'node:assert/strict'
import { postDocumentViaGateway } from '../src/lib/gateway-document.ts'
import type { PostDocumentOutcome } from '../src/lib/gateway-document.ts'

const TOKEN = 'gateway-token-very-secret'
const REQUEST = 'doc-0123456789abcdef0123'
const PDF = new Uint8Array(Buffer.from('%PDF-1.4\nvoorbeeld\n%%EOF\n'))
const answer = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

function run(reply: () => Response | Promise<Response>, extra: { timeoutMs?: number; reference?: { model: 'planning.slot' | 'svs.tech.visit'; id: number } } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return reply()
  }) as unknown as typeof fetch
  const outcome = postDocumentViaGateway({
    url: 'http://odoo-gateway:8070', token: TOKEN, requestId: REQUEST, reference: { model: 'planning.slot', id: 12 },
    filename: 'schouw-familie-20261008.pdf', summary: 'Schouwdocument - Familie - 8 okt 2026', pdf: PDF, fetchImpl, ...extra,
  })
  return { calls, outcome }
}

const kind = (outcome: PostDocumentOutcome) => (outcome.ok ? 'ok' : outcome.kind)

test('the request has the request id, the reference, the file name, the summary and the file, and nothing else: no customer, no model to write to', async () => {
  const { calls, outcome } = run(() => answer(200, { id: 501, noted: true, customer: 'Familie Van den Berg' }))
  await outcome
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://odoo-gateway:8070/v1/actions/post_document')
  assert.equal(calls[0].init.method, 'POST')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.authorization, `Bearer ${TOKEN}`)
  assert.match(headers['content-type'], /^application\/json/)
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    requestId: REQUEST, reference: { model: 'planning.slot', id: 12 }, filename: 'schouw-familie-20261008.pdf',
    summary: 'Schouwdocument - Familie - 8 okt 2026', pdf: Buffer.from(PDF).toString('base64'),
  })
})

test('posted: the customer name and whether the note was placed are passed on; a repeat is marked', async () => {
  const placed = await run(() => answer(200, { id: 501, noted: true, customer: 'Familie Van den Berg' })).outcome
  assert.deepEqual(placed, { ok: true, noted: true, customer: 'Familie Van den Berg', replayed: false })
  const repeat = await run(() => answer(200, { id: 501, noted: false, customer: null, replayed: true })).outcome
  assert.deepEqual(repeat, { ok: true, noted: false, customer: null, replayed: true })
  const long = await run(() => answer(200, { id: 501, noted: true, customer: 'x'.repeat(500) })).outcome
  assert.ok(long.ok && (long.customer?.length ?? 0) <= 120, 'a name from Odoo is kept short')
})

test('a 200 without a usable attachment id is not a success: the file may be there, so it is unknown', async () => {
  for (const body of [{}, { id: 0, noted: true }, { id: 'x', noted: true }, { id: 1.5, noted: true }, 'not json', null]) {
    assert.equal(kind(await run(() => answer(200, body)).outcome), 'unknown', JSON.stringify(body))
  }
})

test('the gateway refuses at the door: switched off or token not valid, and nothing was placed', async () => {
  const off = await run(() => answer(403, { error: 'action_not_allowed' })).outcome
  assert.equal(kind(off), 'not_enabled')
  const token = await run(() => answer(401, { error: 'unauthorized' })).outcome
  assert.equal(kind(token), 'rejected')
  assert.match(token.ok ? '' : token.message, /gateway-token/)
})

test('refused before anything was written: the message says nothing was placed and trying again is safe', async () => {
  const cases: Array<[number, unknown, RegExp]> = [
    [404, { error: 'reference_not_found' }, /afspraak.*Odoo|niet gevonden/i],
    [409, { error: 'reference_has_no_customer' }, /geen klant/i],
    [429, { error: 'rate_limited' }, /te veel/i],
    [413, { error: 'pdf_too_large' }, /te groot/i],
    [413, { error: 'body_too_large' }, /te groot/i],
    [400, { error: 'invalid_pdf' }, /invalid_pdf/],
    [502, { error: 'odoo_rejected', message: 'odoo.exceptions.AccessError' }, /AccessError/],
    [502, { error: 'odoo_error' }, /niets geplaatst|niet geplaatst/i],
    [504, { error: 'odoo_timeout' }, /niets geplaatst|niet geplaatst/i],
  ]
  for (const [status, body, message] of cases) {
    const outcome = await run(() => answer(status, body)).outcome
    assert.equal(kind(outcome), 'rejected', `${status} ${JSON.stringify(body)}`)
    assert.match(outcome.ok ? '' : outcome.message, message, JSON.stringify(body))
  }
})

test('the free text of Odoo is not passed on: only a plain class name or status is', async () => {
  const outcome = await run(() => answer(502, { error: 'odoo_rejected', message: 'Familie Jansen, Kerkstraat 12 mag dit niet' })).outcome
  assert.equal(kind(outcome), 'rejected')
  assert.ok(!(outcome.ok ? '' : outcome.message).includes('Jansen'))
})

test('no usable answer: the file may be there, so the outcome is unknown (also for a repeat while the first runs, a reused id and a proxy error)', async () => {
  for (const [status, body] of [[504, { error: 'outcome_unknown' }], [409, { error: 'outcome_unknown' }], [409, { error: 'in_progress' }], [409, { error: 'request_id_reused' }], [502, '<html>bad gateway</html>'], [500, {}], [503, {}]] as const) {
    const outcome = await run(() => answer(status, body)).outcome
    assert.equal(kind(outcome), 'unknown', `${status} ${JSON.stringify(body)}`)
    assert.match(outcome.ok ? '' : outcome.message, /niet zeker/i)
  }
  assert.equal(kind(await run(() => { throw new Error('connection reset') }).outcome), 'unknown', 'the call may have reached Odoo before it failed')
})

test('a gateway that does not answer in time is unknown, not an endless wait', async () => {
  const outcome = await run(() => new Promise<Response>(() => {}), { timeoutMs: 30 }).outcome
  assert.equal(kind(outcome), 'unknown')
})

test('a reference that is not a planning.slot or svs.tech.visit with a real id never leaves the dashboard', async () => {
  for (const reference of [{ model: 'res.partner', id: 5 }, { model: 'planning.slot', id: 0 }, { model: 'planning.slot', id: 1.5 }, { model: 'planning.slot', id: -3 }] as const) {
    const { calls, outcome } = run(() => answer(200, { id: 501, noted: true, customer: 'X' }), { reference: reference as never })
    const result = await outcome
    assert.equal(kind(result), 'rejected', JSON.stringify(reference))
    assert.equal(calls.length, 0)
  }
})

test('a file that is not a PDF or is over 8 MB never leaves the dashboard', async () => {
  const calls: unknown[] = []
  const fetchImpl = (async () => { calls.push(1); return answer(200, {}) }) as unknown as typeof fetch
  const base = { url: 'http://odoo-gateway:8070', token: TOKEN, requestId: REQUEST, reference: { model: 'planning.slot' as const, id: 12 }, filename: 'schouw-x-20261008.pdf', summary: 'x', fetchImpl }
  assert.equal(kind(await postDocumentViaGateway({ ...base, pdf: new Uint8Array(Buffer.from('GIF89a....')) })), 'rejected')
  const big = new Uint8Array(8 * 1024 * 1024 + 1)
  big.set(Buffer.from('%PDF-1.4'))
  const tooBig = await postDocumentViaGateway({ ...base, pdf: big })
  assert.equal(kind(tooBig), 'rejected')
  assert.match(tooBig.ok ? '' : tooBig.message, /8 MB/)
  assert.equal(calls.length, 0)
})
