import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanCustomer, DOCUMENT_BODY_CHARS } from '../src/lib/document-handlers.ts'
import { requestIdFor } from '../src/lib/document-journal.ts'
import { DATA, PASSWORD, login, read, read as read_, request, setup, slot } from './api-helpers.ts'
import type { Api } from './api-helpers.ts'
import { PHOTO, SIGNATURE } from './documents-fixtures.ts'

const jan = async (api: Api) => (await login(api, 'jan')).cookie
const planner = async (api: Api) => (await login(api, 'planner')).cookie
const sanne = async (api: Api) => {
  if (!api.accounts.list().some((account) => account.username === 'sanne')) {
    api.accounts.create({ username: 'sanne', name: 'Sanne Smit', role: 'monteur', personId: 'employee:8', password: PASSWORD })
  }
  return (await login(api, 'sanne')).cookie
}

const SUBMISSION = 'f3b1c2d4-5e6f-4a7b-8c9d-0123456789ab'
const schouwAnswers = {
  parkeren: { value: 'ja' },
  huisdieren: { value: 'nee' },
  werkzaamheden: 'sanitair',
  meterkast: { value: 'nvt' },
  asbest: { value: 'nee' },
  fotos_situatie: [PHOTO],
}
const body = (overrides: Record<string, unknown> = {}) => ({
  type: 'schouw', appointmentId: 'slot-1', submissionId: SUBMISSION, answers: schouwAnswers, signature: { name: 'Mevr. Klant', image: SIGNATURE }, ...overrides,
})
const post = (api: Api, cookie: string | undefined, payload: unknown, init: { csrf?: boolean } = {}) =>
  api.handlers.documentsPost(request('/api/documents', { method: 'POST', cookie, body: payload, csrf: init.csrf }))
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')

test('a technician sends the schouw of his own appointment: the PDF goes to the gateway and the journal says posted', async () => {
  const api = setup()
  const answer = await read(await post(api, await jan(api), body()))
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json, { ok: true, state: 'posted', noted: true, customer: 'Klant van Odoo', replayed: false })
  assert.equal(api.odoo.docs.posts.length, 1)
  const sent = api.odoo.docs.posts[0]
  assert.deepEqual(Object.keys(sent).sort(), ['filename', 'pdf', 'reference', 'requestId', 'summary'], 'nothing but these five go out: no customer, no model to write to')
  assert.equal(sent.requestId, requestIdFor(SUBMISSION))
  assert.deepEqual(sent.reference, { model: 'planning.slot', id: 1 })
  assert.equal(sent.filename, 'schouw-klant-1-20261008.pdf')
  assert.match(sent.summary, /^Schouwdocument – Klant 1 – /)
  assert.equal(latin1(sent.pdf.subarray(0, 5)), '%PDF-')
  assert.ok(latin1(sent.pdf).includes('Jan de Vries'), 'the PDF names the logged-in technician as the author')
  assert.ok(!answer.text.includes(sent.requestId) && !answer.text.includes('%PDF'), 'the answer carries neither the request id nor the file')
  assert.deepEqual(api.documents.list().map((entry) => [entry.state, entry.type, entry.appointmentId, entry.noted]), [['posted', 'schouw', 'slot-1', true]])
})

test('an oplevering is its own form and file name', async () => {
  const api = setup()
  const answer = await read(await post(api, await jan(api), body({
    type: 'oplevering',
    answers: { uitgevoerd: 'Radiator vervangen.', volledig: { value: 'ja' }, getest: { value: 'ja' }, instructie: { value: 'nvt' }, opgeruimd: { value: 'ja' } },
  })))
  assert.equal(answer.status, 200, answer.text)
  assert.match(api.odoo.docs.posts[0].filename, /^oplevering-klant-1-20261008\.pdf$/)
  assert.match(api.odoo.docs.posts[0].summary, /^Opleverdocument – /)
})

test('who it is comes from the session: an author in the request is refused, and every other unknown field too', async () => {
  const api = setup()
  const cookie = await jan(api)
  for (const extra of [{ author: 'Een ander' }, { partnerId: 5 }, { customer: 'X' }, { reference: { model: 'res.partner', id: 5 } }, { model: 'res.partner' }, { pdf: 'x' }, { filename: 'a.pdf' }]) {
    const answer = await read(await post(api, cookie, body(extra)))
    assert.equal(answer.status, 400, JSON.stringify(extra))
  }
  assert.equal(api.odoo.docs.posts.length, 0)
  assert.equal(api.documents.list().length, 0)
})

test('a technician can send only for his own appointments; the planner for every appointment', async () => {
  const api = setup()
  const own = await jan(api)
  assert.equal((await read(await post(api, own, body({ appointmentId: 'slot-2' })))).status, 404, 'an appointment of somebody else looks like it does not exist')
  assert.equal((await read(await post(api, own, body({ appointmentId: 'slot-99' })))).status, 404)
  assert.equal((await read(await post(api, own, body({ appointmentId: 'visit-101' })))).status, 404, 'a visit nobody is planned on')
  assert.equal(api.odoo.docs.posts.length, 0)
  assert.equal((await read(await post(api, await sanne(api), body({ appointmentId: 'slot-2' })))).status, 200)
  assert.deepEqual(api.odoo.docs.posts[0].reference, { model: 'planning.slot', id: 2 })
  const office = await planner(api)
  const forVisit = await read(await post(api, office, body({ appointmentId: 'visit-101', submissionId: 'office-submission-0000002' })))
  assert.equal(forVisit.status, 200, forVisit.text)
  assert.deepEqual(api.odoo.docs.posts[1].reference, { model: 'svs.tech.visit', id: 101 }, 'a visit without planning is referred to as a visit')
  assert.equal((await read(await post(api, office, body({ appointmentId: 'slot-3', submissionId: 'office-submission-0000003' })))).status, 200)
  assert.match(latin1(api.odoo.docs.posts[2].pdf), /Petra Planner/, 'the planner is the author of what the planner sends')
})

test('logged out, without the header of the dashboard and with logins off nothing can be sent', async () => {
  const api = setup()
  assert.equal((await read(await post(api, undefined, body()))).status, 401)
  assert.equal((await read(await post(api, await jan(api), body(), { csrf: false }))).status, 403)
  assert.equal((await read(await api.handlers.documentsPost(request('/api/documents', { cookie: await jan(api) })))).status, 415, 'a GET without a body is not a document')
  const off = setup({ mode: 'off' })
  assert.equal((await read(await post(off, undefined, body()))).status, 404)
  const unset = setup({ configured: false })
  assert.equal((await read(await post(unset, undefined, body()))).status, 503)
  for (const open of [api, off, unset]) assert.equal(open.odoo.docs.posts.length, 0)
})

test('odd values are a 400 before anything is looked up', async () => {
  const api = setup()
  const cookie = await jan(api)
  const cases: Array<[string, unknown]> = [
    ['no body', 'not json'],
    ['array', []],
    ['type', body({ type: 'offerte' })],
    ['type missing', body({ type: undefined })],
    ['appointment', body({ appointmentId: 'slot-1; drop' })],
    ['appointment number', body({ appointmentId: 12 })],
    ['appointment zero', body({ appointmentId: 'slot-0' })],
    ['appointment model', body({ appointmentId: 'partner-1' })],
    ['submission short', body({ submissionId: 'short' })],
    ['submission chars', body({ submissionId: 'with spaces in the submission id' })],
    ['submission number', body({ submissionId: 1234567890123456 })],
  ]
  for (const [label, payload] of cases) {
    const answer = await read(await post(api, cookie, payload))
    assert.equal(answer.status, 400, label)
  }
  assert.equal(api.odoo.docs.posts.length, 0)
  assert.equal(api.loads.length, 0, 'Odoo was not even read')
})

test('a form that is not filled in right is a 422 with the fields that are wrong, and nothing is sent or kept', async () => {
  const api = setup()
  const answer = await read(await post(api, await jan(api), body({
    answers: { ...schouwAnswers, parkeren: undefined, werkzaamheden: 'tuinhuis', fotos_situatie: ['data:image/png;base64,AAAA'] },
    signature: { name: 'x', image: '' },
  })))
  assert.equal(answer.status, 422)
  assert.deepEqual(Object.keys(answer.json.errors).sort(), ['fotos_situatie', 'parkeren', 'signature.image', 'signature.name', 'werkzaamheden'])
  assert.equal(typeof answer.json.error, 'string')
  assert.equal(api.odoo.docs.posts.length, 0)
  assert.equal(api.documents.list().length, 0, 'a form that was never valid leaves no trace')
})

test('a document with a lot of text is fine: the limit of the other routes (16 KB) does not apply, only the one of documents', async () => {
  const api = setup()
  const text = 'Een regel tekst. '.repeat(235).slice(0, 4000)
  const payload = body({ answers: { ...schouwAnswers, ruimte: text, toegang: text, aandachtspunten: text, opmerkingen_klant: text } })
  assert.ok(JSON.stringify(payload).length > 16 * 1024 + 1000, 'more than the 16 KB of the other routes')
  const answer = await read(await post(api, await jan(api), payload))
  assert.equal(answer.status, 200, answer.text)
})

test('a request that is far too big is refused without being read', async () => {
  const api = setup()
  const cookie = await jan(api)
  const huge = 'x'.repeat(DOCUMENT_BODY_CHARS + 1)
  const answer = await read(await post(api, cookie, body({ answers: { ...schouwAnswers, ruimte: huge } })))
  assert.equal(answer.status, 413)
  assert.equal(api.odoo.docs.posts.length, 0)
  // Photos in a normal request are far over the 16 KB of the other routes and are fine.
  const photos = await read(await post(api, cookie, body({ answers: { ...schouwAnswers, fotos_situatie: [PHOTO, PHOTO, PHOTO, PHOTO] } })))
  assert.equal(photos.status, 200, photos.text)
})

test('sending the same document again gives the same answer once: the gateway is not asked twice', async () => {
  const api = setup()
  const cookie = await jan(api)
  assert.equal((await read(await post(api, cookie, body()))).status, 200)
  const again = await read(await post(api, cookie, body()))
  assert.equal(again.status, 200)
  assert.deepEqual(again.json, { ok: true, state: 'posted', noted: true, customer: null, replayed: true })
  assert.equal(api.odoo.docs.posts.length, 1)
  const other = await read(await post(api, await sanne(api), body({ appointmentId: 'slot-2' })))
  assert.equal(other.status, 409, 'somebody else cannot use the number of this document')
  assert.equal((await read(await post(api, await planner(api), body()))).status, 409, 'not even somebody who may see the same appointment')
  assert.equal((await read(await post(api, cookie, body({ appointmentId: 'slot-3' })))).status, 409, 'nor can it be used for another appointment')
  assert.equal((await read(await post(api, cookie, body({ type: 'oplevering', answers: {} })))).status, 409, 'nor for another kind of document')
  assert.equal(api.odoo.docs.posts.length, 1)
})

test('while the first runs, a repeat is told to wait and does not reach the gateway', async () => {
  const api = setup()
  const cookie = await jan(api)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  api.odoo.docs.answer = async () => {
    await gate
    return { ok: true, noted: true, customer: 'Klant van Odoo', replayed: false }
  }
  const first = post(api, cookie, body())
  await new Promise((resolve) => setTimeout(resolve, 20))
  const repeat = await read(await post(api, cookie, body()))
  assert.equal(repeat.status, 409)
  assert.match(repeat.json.error, /nog verstuurd|wacht/i)
  release()
  assert.equal((await read(await first)).status, 200)
  assert.equal(api.odoo.docs.posts.length, 1)
})

test('refused by Odoo: nothing was placed, the message says so, and the same document may be sent again', async () => {
  const api = setup()
  const cookie = await jan(api)
  api.odoo.docs.answer = () => ({ ok: false, kind: 'rejected', message: 'Bij deze afspraak staat in Odoo geen klant. Er is niets geplaatst.' })
  const refused = await read(await post(api, cookie, body()))
  assert.equal(refused.status, 502)
  assert.equal(refused.json.error, 'Bij deze afspraak staat in Odoo geen klant. Er is niets geplaatst.')
  assert.equal(refused.json.retry, true)
  assert.equal(api.documents.list().length, 0, 'nothing is left behind that blocks a second try')
  api.odoo.docs.answer = () => ({ ok: true, noted: true, customer: 'Klant van Odoo', replayed: false })
  assert.equal((await read(await post(api, cookie, body()))).status, 200)
  assert.equal(api.odoo.docs.posts.length, 2)
  assert.equal(api.odoo.docs.posts[0].requestId, api.odoo.docs.posts[1].requestId, 'the same request id: the gateway forgot the refused one')
})

test('switched off in the gateway: the message says so, nothing was placed, and nothing blocks a later try', async () => {
  const api = setup()
  api.odoo.docs.answer = () => ({ ok: false, kind: 'not_enabled', message: 'Het versturen van documenten naar Odoo staat niet aan op de server.' })
  const answer = await read(await post(api, await jan(api), body()))
  assert.equal(answer.status, 503)
  assert.equal(answer.json.retry, false)
  assert.equal(api.documents.list().length, 0)
})

test('no usable answer: it is unknown whether the file is there, so the same document is NOT sent again; a new try is the person\'s own choice', async () => {
  const api = setup()
  const cookie = await jan(api)
  api.odoo.docs.answer = () => ({ ok: false, kind: 'unknown', message: 'Er kwam geen bruikbaar antwoord van Odoo. Het is niet zeker of het document bij de klant staat.' })
  const unclear = await read(await post(api, cookie, body()))
  assert.equal(unclear.status, 504)
  assert.equal(unclear.json.retry, false)
  assert.match(unclear.json.error, /niet zeker/)
  assert.equal(api.documents.get(SUBMISSION)?.state, 'unknown')

  api.odoo.docs.answer = () => ({ ok: true, noted: true, customer: 'Klant van Odoo', replayed: false })
  const blocked = await read(await post(api, cookie, body()))
  assert.equal(blocked.status, 409)
  assert.match(blocked.json.error, /niet zeker/)
  assert.equal(api.odoo.docs.posts.length, 1, 'the gateway was not asked again')
  const fresh = await read(await post(api, cookie, body({ submissionId: 'a-second-attempt-0000001' })))
  assert.equal(fresh.status, 200, 'a new submission number is a new document')
  assert.equal(api.odoo.docs.posts.length, 2)
})

test('an entry that stayed "sending" (the server stopped) is unknown after a few minutes, not an endless wait', async () => {
  const api = setup()
  const cookie = await jan(api)
  api.documents.begin({ submissionId: SUBMISSION, type: 'schouw', appointmentId: 'slot-1', by: api.accounts.list().find((account) => account.username === 'jan')?.id as string })
  assert.equal((await read(await post(api, cookie, body()))).status, 409)
  api.documentClock.now = new Date('2026-10-08T09:40:00Z')
  const later = await read(await post(api, cookie, body()))
  assert.equal(later.status, 409)
  assert.match(later.json.error, /niet zeker/)
  assert.equal(api.documents.get(SUBMISSION)?.state, 'unknown')
  assert.equal(api.odoo.docs.posts.length, 0)
})

test('the note missing is not a failure: the file is on the customer and the answer says the note is not', async () => {
  const api = setup()
  api.odoo.docs.answer = () => ({ ok: true, noted: false, customer: null, replayed: false })
  const answer = await read(await post(api, await jan(api), body()))
  assert.deepEqual(answer.json, { ok: true, state: 'posted', noted: false, customer: null, replayed: false })
  assert.equal(api.documents.get(SUBMISSION)?.noted, false)
})

test('when the planning cannot be read there is no document: 502 and nothing kept', async () => {
  const api = setup()
  api.control.failWith = new Error('Odoo is stuk')
  const answer = await read(await post(api, await jan(api), body()))
  assert.equal(answer.status, 502)
  assert.equal(api.odoo.docs.posts.length, 0)
  assert.equal(api.documents.list().length, 0)
})

test('an appointment of Odoo that has no slot or visit id cannot be a reference', async () => {
  // The id of an appointment is `slot-N` or `visit-N`; anything else never matches an appointment.
  const api = setup()
  assert.equal((await read(await post(api, await planner(api), body({ appointmentId: 'slot-1e3' })))).status, 400)
})

test('the customer of the appointment goes into the file name and the note as one plain line', async () => {
  const api = setup()
  api.control.data = { ...DATA, slots: [slot(1, { employee_ids: [[7, 'Jan']], partner_name: 'Familie\nVan\tden   Berg' })], visits: [] }
  const answer = await read(await post(api, await jan(api), body()))
  assert.equal(answer.status, 200, answer.text)
  assert.equal(api.odoo.docs.posts[0].filename, 'schouw-familie-van-den-berg-20261008.pdf')
  assert.match(api.odoo.docs.posts[0].summary, /^Schouwdocument – Familie Van den Berg – /)
})

test('the name of the customer in the file name and the note is one plain line', () => {
  assert.equal(cleanCustomer('Familie\nVan den Berg\t(Houten)'), 'Familie Van den Berg (Houten)')
  assert.equal(cleanCustomer('x'.repeat(300)).length, 120)
  assert.equal(cleanCustomer('  '), 'Klant')
  assert.equal(cleanCustomer(null as never), 'Klant')
})

test('a request that says it is too big is refused before its body is read', async () => {
  const api = setup()
  const cookie = await jan(api)
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close() } })
  const huge = new Request('http://dash.test/api/documents', {
    method: 'POST', headers: { cookie: cookie ?? '', 'x-dig-dashboard': '1', 'content-type': 'application/json', 'content-length': String(DOCUMENT_BODY_CHARS + 1) },
    body: stream, duplex: 'half',
  } as RequestInit)
  const answer = await read_(await api.handlers.documentsPost(huge))
  assert.equal(answer.status, 413)
  assert.equal(huge.bodyUsed, false, 'the body was not read')
})
