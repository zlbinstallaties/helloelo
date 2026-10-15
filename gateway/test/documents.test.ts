import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OdooError, OdooWriteError, type OdooClient, type PostDocumentParams } from '../../src/lib/odoo-client.ts'
import { parseProjects, sha256Hex } from '../src/projects.ts'
import { createGateway, type AccessLogEntry } from '../src/server.ts'

const DOCS = 'docs-token-123'
const READER = 'reader-token-456'
const REQUEST = 'req-0123456789abcdef'
const NOW = Date.UTC(2026, 9, 8, 10, 0)

const projects = parseProjects({
  projects: [
    { id: 'dashboard-docs', tokenSha256: sha256Hex(DOCS), companyId: 2, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } }, actions: { postDocument: { maxPerHour: 3 } } },
    { id: 'preview', tokenSha256: sha256Hex(READER), companyId: 2, models: { 'planning.slot': { fields: ['name'], methods: ['search_read'] } } },
  ],
})

const pdf = (extra = '') => Buffer.from(`%PDF-1.4\n${extra}%%EOF\n`).toString('base64')
const body = (overrides: Record<string, unknown> = {}) => ({
  requestId: REQUEST, reference: { model: 'planning.slot', id: 12 }, filename: 'schouw-familie-20261008.pdf', summary: 'Schouwdocument - Familie - 8 okt 2026', pdf: pdf(), ...overrides,
})

type Call = { method: string; params: any }

function fakeOdoo(overrides: Partial<OdooClient> = {}) {
  const calls: Call[] = []
  const unexpected = (name: string) => async () => { throw new Error(`unexpected call: ${name}`) }
  const odoo: OdooClient = {
    searchRead: unexpected('searchRead'), searchCount: unexpected('searchCount'), fieldsGet: unexpected('fieldsGet'), createEmployee: unexpected('createEmployee'),
    setEmployeePlanningRoles: unexpected('setEmployeePlanningRoles'), checkResponsible: unexpected('checkResponsible'), checkPlanningRoles: unexpected('checkPlanningRoles'),
    listPlanningRoles: unexpected('listPlanningRoles'), readEmployee: unexpected('readEmployee'), createUnavailability: unexpected('createUnavailability'),
    readUnavailability: unexpected('readUnavailability'), removeUnavailability: unexpected('removeUnavailability'),
    async readReferencePartner(params) {
      calls.push({ method: 'readReferencePartner', params })
      return params.id === 12 ? { partnerId: 77, partnerName: 'Familie Van den Berg' } : params.id === 13 ? { partnerId: null, partnerName: null } : null
    },
    async postDocument(params: PostDocumentParams) {
      calls.push({ method: 'postDocument', params })
      return { attachmentId: 501, noted: true }
    },
    ...overrides,
  }
  return { odoo, calls, names: () => calls.map((call) => call.method), count: (method: string) => calls.filter((call) => call.method === method).length }
}

async function withGateway(odoo: OdooClient, run: (post: (payload: unknown, init?: { token?: string | null; method?: string; raw?: string }) => Promise<{ status: number; json: Record<string, any> }>, base: string) => Promise<void>, options: { logs?: AccessLogEntry[]; now?: () => number } = {}) {
  const server: Server = createServer(createGateway({ projects, odoo, log: (entry) => options.logs?.push(entry), now: options.now ?? (() => NOW) }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await run(async (payload, init = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (init.token !== null) headers.authorization = `Bearer ${init.token ?? DOCS}`
      const method = init.method ?? 'POST'
      const response = await fetch(`${base}/v1/actions/post_document`, { method, headers, body: method === 'GET' ? undefined : (init.raw ?? JSON.stringify(payload)) })
      return { status: response.status, json: (await response.json()) as Record<string, any> }
    }, base)
  } finally {
    // A client that was cut off (a body that was too big) may leave a socket behind that would hold the close up.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('a project without the action cannot post a document, and Odoo is not called; no or a wrong token is 401; only POST', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    assert.equal((await post(body(), { token: READER })).json.error, 'action_not_allowed')
    assert.equal((await post(body(), { token: null })).status, 401)
    assert.equal((await post(body(), { token: 'nope' })).status, 401)
    assert.equal((await post(body(), { method: 'GET' })).status, 405)
    assert.equal(calls.length, 0)
  })
})

test('posting: the customer is read from the reference record and the file goes on that customer, with the note', async () => {
  const { odoo, calls, names } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    const answer = await post(body())
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.json, { id: 501, noted: true, customer: 'Familie Van den Berg' })
    assert.deepEqual(names(), ['readReferencePartner', 'postDocument'])
    assert.deepEqual(calls[0].params, { model: 'planning.slot', id: 12, companyId: 2 })
    assert.deepEqual(calls[1].params, { partnerId: 77, companyId: 2, filename: 'schouw-familie-20261008.pdf', pdfBase64: pdf(), note: 'Schouwdocument - Familie - 8 okt 2026' })
  })
  const visit = fakeOdoo()
  await withGateway(visit.odoo, async (post) => {
    assert.equal((await post(body({ reference: { model: 'svs.tech.visit', id: 12 } }))).status, 200)
    assert.equal(visit.calls[0].params.model, 'svs.tech.visit')
  })
})

test('posting: only requestId, reference, filename, summary and pdf; never a customer, a record, a model or an address of the caller', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    for (const extra of [{ partnerId: 5 }, { partner_id: 5 }, { res_id: 5 }, { res_model: 'res.users' }, { model: 'res.partner' }, { customer: 'X' }, { url: 'http://x' }, { vals: {} }, { subtype: 'mt_comment' }, { partner_ids: [1] }, { email: 'a@b.nl' }]) {
      const answer = await post(body(extra))
      assert.equal(answer.status, 400, JSON.stringify(extra))
      assert.equal(answer.json.error, 'unknown_parameter')
    }
    for (const reference of [{ model: 'planning.slot', id: 12, partnerId: 5 }, { model: 'planning.slot', id: 12, partner_id: 5 }]) {
      const answer = await post(body({ reference }))
      assert.equal(answer.status, 400)
      assert.equal(answer.json.error, 'invalid_reference')
    }
    assert.equal(calls.length, 0)
  })
})

test('posting: odd references, file names, summaries and files are a 400 and Odoo is not called', async () => {
  const { odoo, calls } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ requestId: 'kort' }, 'invalid_request_id'], [{ requestId: undefined }, 'invalid_request_id'],
      [{ reference: undefined }, 'invalid_reference'], [{ reference: 'planning.slot:12' }, 'invalid_reference'], [{ reference: [] }, 'invalid_reference'], [{ reference: { model: 'res.partner', id: 12 } }, 'invalid_reference'],
      [{ reference: { model: 'hr.employee', id: 12 } }, 'invalid_reference'], [{ reference: { model: 'planning.slot', id: 0 } }, 'invalid_reference'], [{ reference: { model: 'planning.slot', id: '12' } }, 'invalid_reference'],
      [{ reference: { model: 'planning.slot', id: 1.5 } }, 'invalid_reference'], [{ reference: { model: 'planning.slot', id: -3 } }, 'invalid_reference'], [{ reference: { model: 'planning.slot', id: 2_147_483_648 } }, 'invalid_reference'],
      [{ reference: { model: 'planning.slot' } }, 'invalid_reference'], [{ reference: { id: 12 } }, 'invalid_reference'],
      [{ filename: '' }, 'invalid_filename'], [{ filename: '../x.pdf' }, 'invalid_filename'], [{ filename: 'a/b.pdf' }, 'invalid_filename'], [{ filename: 'x.exe' }, 'invalid_filename'], [{ filename: 5 }, 'invalid_filename'], [{ filename: undefined }, 'invalid_filename'],
      [{ summary: '' }, 'invalid_summary'], [{ summary: '   ' }, 'invalid_summary'], [{ summary: 'x'.repeat(301) }, 'invalid_summary'], [{ summary: 'twee\nregels' }, 'invalid_summary'], [{ summary: 'met\ttab' }, 'invalid_summary'], [{ summary: `met${String.fromCharCode(127)}delete` }, 'invalid_summary'], [{ summary: 5 }, 'invalid_summary'],
      [{ pdf: '' }, 'invalid_pdf'], [{ pdf: 5 }, 'invalid_pdf'], [{ pdf: 'geen base64!' }, 'invalid_pdf'], [{ pdf: Buffer.from('geen pdf').toString('base64') }, 'invalid_pdf'],
      [{ pdf: Buffer.from('%PDF-1.4 zonder einde').toString('base64') }, 'invalid_pdf'], [{ pdf: Buffer.from('zonder kop\n%%EOF\n').toString('base64') }, 'invalid_pdf'], [{ pdf: `${pdf()}A` }, 'invalid_pdf'], [{ pdf: undefined }, 'invalid_pdf'],
    ]
    for (const [overrides, code] of cases) {
      const answer = await post(body(overrides))
      assert.equal(answer.status, 400, JSON.stringify(overrides).slice(0, 80))
      assert.equal(answer.json.error, code, JSON.stringify(overrides).slice(0, 80))
    }
    assert.equal(calls.length, 0)
  })
})

test('posting: a file of a few MB is fine although the other routes take 64 KB; over 8 MB is refused, and a body of more than 12 MB is refused outright', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    const big = pdf('x'.repeat(3 * 1024 * 1024))
    assert.equal((await post(body({ pdf: big }))).status, 200)
    const tooBig = pdf('x'.repeat(8 * 1024 * 1024 + 1))
    const refused = await post(body({ requestId: 'req-2-0123456789abcdef', pdf: tooBig }))
    assert.equal(refused.status, 413)
    assert.equal(refused.json.error, 'pdf_too_large')
    assert.equal(count('postDocument'), 1)
    // The limit is on the bytes of the file, not on the length of the text: exactly 8 MiB is fine (its base64 ends in one =), one more is not.
    const head = '%PDF-1.4\n'
    const tail = '\n%%EOF\n'
    const exact = Buffer.concat([Buffer.from(head), Buffer.alloc(8 * 1024 * 1024 - head.length - tail.length, 0x20), Buffer.from(tail)])
    assert.equal(exact.length, 8 * 1024 * 1024)
    assert.equal((await post(body({ requestId: 'req-3-0123456789abcdef', pdf: exact.toString('base64') }))).status, 200)
    const over = Buffer.concat([exact, Buffer.from(' ')])
    assert.equal((await post(body({ requestId: 'req-4-0123456789abcdef', pdf: over.toString('base64') }))).status, 413)
    assert.equal(count('postDocument'), 2)
  })
  // A body that announces more than 12 MB is refused from its header alone, before it is read.
  await withGateway(odoo, async (_post, base) => {
    const answer = await new Promise<{ status: number; json: Record<string, any> }>((resolve, reject) => {
      const url = new URL('/v1/actions/post_document', base)
      const request = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${DOCS}`, 'content-length': String(13 * 1024 * 1024) } }, (response) => {
        let data = ''
        response.on('data', (chunk) => (data += chunk))
        response.on('end', () => { request.destroy(); resolve({ status: response.statusCode ?? 0, json: JSON.parse(data) }) })
      })
      request.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error) })
      request.write('{')
    })
    assert.equal(answer.status, 413)
    assert.equal(answer.json.error, 'body_too_large')
  })
  // A body that does not say how big it is (chunked) is cut off while it is read: the answer is a 413 or a closed connection, never a go-ahead.
  const quiet = fakeOdoo()
  await withGateway(quiet.odoo, async (_post, base) => {
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL('/v1/actions/post_document', base)
      const request = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${DOCS}`, 'transfer-encoding': 'chunked' } }, (response) => {
        response.resume()
        response.on('end', () => { request.destroy(); resolve(response.statusCode ?? 0) })
      })
      request.on('error', (error) => { if (['ECONNRESET', 'EPIPE'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(0); else reject(error) })
      request.on('close', () => resolve(0))
      const piece = Buffer.alloc(1024 * 1024, 0x20)
      request.write('{"pdf":"')
      for (let index = 0; index < 14; index++) request.write(piece)
    })
    assert.ok(status === 413 || status === 0, `status ${status}`)
    assert.equal(quiet.count('postDocument'), 0)
  })
})

test('posting: a record that is not in the company, or a record without a customer, stops it before anything is written', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    const gone = await post(body({ reference: { model: 'planning.slot', id: 99 } }))
    assert.equal(gone.status, 404)
    assert.equal(gone.json.error, 'reference_not_found')
    const none = await post(body({ reference: { model: 'planning.slot', id: 13 }, requestId: 'req-2-0123456789abcdef' }))
    assert.equal(none.status, 409)
    assert.equal(none.json.error, 'reference_has_no_customer')
    assert.equal(count('postDocument'), 0)
  })
})

test('posting twice with the same request id gives the same answer once; another document with that id is refused', async () => {
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    const first = await post(body())
    const again = await post(body())
    assert.deepEqual(again.json, { ...first.json, replayed: true })
    assert.equal(count('postDocument'), 1)
    for (const other of [{ reference: { model: 'planning.slot', id: 14 } }, { reference: { model: 'svs.tech.visit', id: 12 } }, { filename: 'oplevering-x-20261008.pdf' }, { summary: 'Anders' }, { pdf: pdf('anders ') }]) {
      const refused = await post(body(other))
      assert.equal(refused.status, 409, JSON.stringify(other).slice(0, 60))
      assert.equal(refused.json.error, 'request_id_reused')
    }
    assert.equal(count('postDocument'), 1)
  })
})

test('posting: while the first runs a repeat is refused; a refusal of Odoo may be repeated; silence blocks the request id', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const running = fakeOdoo({ async postDocument() { await gate; return { attachmentId: 501, noted: true } } })
  await withGateway(running.odoo, async (post) => {
    const first = post(body())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const repeat = await post(body())
    assert.equal(repeat.status, 409)
    assert.equal(repeat.json.error, 'in_progress')
    release()
    assert.equal((await first).status, 200)
  })

  let mode: 'reject' | 'unknown' | 'fine' = 'reject'
  let writes = 0
  const { odoo } = fakeOdoo({
    async postDocument() {
      writes++
      if (mode === 'reject') throw new OdooWriteError('no', 403, 'rejected', 'odoo.exceptions.AccessError')
      if (mode === 'unknown') throw new OdooWriteError('down', 0, 'unknown')
      return { attachmentId: 502, noted: false }
    },
  })
  await withGateway(odoo, async (post) => {
    const refused = await post(body())
    assert.equal(refused.status, 502)
    assert.equal(refused.json.error, 'odoo_rejected')
    mode = 'fine'
    const ok = await post(body())
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.json, { id: 502, noted: false, customer: 'Familie Van den Berg' }, 'the file is there, only the note is missing')
    mode = 'unknown'
    const unclear = await post(body({ requestId: 'req-2-0123456789abcdef' }))
    assert.equal(unclear.status, 504)
    assert.equal(unclear.json.error, 'outcome_unknown')
    mode = 'fine'
    const blocked = await post(body({ requestId: 'req-2-0123456789abcdef' }))
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json.error, 'outcome_unknown')
    assert.equal(writes, 3, 'the blocked request id never reached Odoo again')
  })
})

test('posting: at most a few documents per hour per project; an hour later it works again', async () => {
  let now = NOW
  const { odoo, count } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    for (let index = 1; index <= 3; index++) assert.equal((await post(body({ requestId: `req-${index}-0123456789abcdef` }))).status, 200)
    const limited = await post(body({ requestId: 'req-9-0123456789abcdef' }))
    assert.equal(limited.status, 429)
    assert.equal(limited.json.error, 'rate_limited')
    assert.equal(count('postDocument'), 3)
    now += 61 * 60_000
    assert.equal((await post(body({ requestId: 'req-9-0123456789abcdef' }))).status, 200)
  }, { now: () => now })
})

test('posting: when Odoo cannot be read before writing, nothing was written and the request may be repeated', async () => {
  let fail = true
  const { odoo, count } = fakeOdoo({
    async readReferencePartner() {
      if (fail) throw new OdooError('Odoo planning.slot read failed (500)', 500, 'builtins.ValueError', true)
      return { partnerId: 77, partnerName: 'Familie' }
    },
  })
  await withGateway(odoo, async (post) => {
    const answer = await post(body())
    assert.equal(answer.status, 502)
    assert.equal(answer.json.error, 'odoo_error')
    fail = false
    assert.equal((await post(body())).status, 200, 'the same request id works after a failed read')
    assert.equal(count('postDocument'), 1)
  })
})

test('the log has the request id and never the file name, the summary, the file, the customer or the token', async () => {
  const logs: AccessLogEntry[] = []
  const { odoo } = fakeOdoo()
  await withGateway(odoo, async (post) => {
    await post(body())
    await post(body({ requestId: 'req-2-0123456789abcdef', reference: { model: 'planning.slot', id: 99 } }))
  }, { logs })
  const text = JSON.stringify(logs)
  for (const secret of ['schouw-familie', 'Schouwdocument', 'Van den Berg', DOCS, pdf()]) assert.ok(!text.includes(secret), secret.slice(0, 20))
  assert.deepEqual(logs.map((entry) => [entry.route, entry.status, entry.requestId]), [
    ['POST /v1/actions/post_document', 200, REQUEST],
    ['POST /v1/actions/post_document', 404, 'req-2-0123456789abcdef'],
  ])
})

test('the action is no other action: a project with it cannot create employees, set roles or mark anybody as not available', async () => {
  const { odoo } = fakeOdoo()
  const server = createServer(createGateway({ projects, odoo, now: () => NOW }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    for (const path of ['/v1/actions/create_employee', '/v1/actions/set_employee_planning_roles', '/v1/actions/add_employee_unavailability', '/v1/actions/remove_employee_unavailability']) {
      const response = await fetch(url + path, { method: 'POST', headers: { authorization: `Bearer ${DOCS}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: REQUEST, name: 'X', employeeId: 41, planningRoleIds: [] }) })
      assert.equal(response.status, 403, path)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
