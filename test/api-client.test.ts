import test from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError } from '../src/lib/api-client.ts'

type Call = { url: string; init: RequestInit }

function fake(reply: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} })
    return reply()
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const headersOf = (call: Call) => call.init.headers as Record<string, string>

test('a read sends no body and no header of the dashboard', async () => {
  const { calls, fetchImpl } = fake(() => json({ a: 1 }))
  assert.deepEqual(await api('/api/auth/me', {}, fetchImpl), { a: 1 })
  assert.equal(calls[0].url, '/api/auth/me')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(headersOf(calls[0])['x-dig-dashboard'], undefined)
})

test('everything that changes something carries the header of the dashboard, with a JSON body when there is one', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const { calls, fetchImpl } = fake(() => json({ ok: true }))
    await api('/api/x', { method, body: { name: 'Jan' } }, fetchImpl)
    assert.equal(calls[0].init.method, method)
    assert.equal(headersOf(calls[0])['x-dig-dashboard'], '1')
    assert.equal(headersOf(calls[0])['content-type'], 'application/json')
    assert.equal(calls[0].init.body, JSON.stringify({ name: 'Jan' }))
  }
  const { calls, fetchImpl } = fake(() => json({ ok: true }))
  await api('/api/x', { method: 'POST' }, fetchImpl)
  assert.equal(headersOf(calls[0])['x-dig-dashboard'], '1')
  assert.equal(calls[0].init.body, undefined)
})

test('an error answer becomes an ApiError with the status, the message of the server and the data', async () => {
  const { fetchImpl } = fake(() => json({ error: 'Niet ingelogd.', employeeId: 41 }, 401))
  await assert.rejects(api('/api/x', {}, fetchImpl), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 401)
    assert.equal(error.message, 'Niet ingelogd.')
    assert.equal(error.data.employeeId, 41)
    return true
  })
})

test('an error without a usable message gets the fallback and the status', async () => {
  const bodies = [() => new Response('<h1>Er ging iets mis</h1>', { status: 500 }), () => json({ error: '' }, 500), () => json({}, 500), () => json([], 500)]
  for (const reply of bodies) {
    const { fetchImpl } = fake(reply)
    await assert.rejects(api('/api/x', { fallback: 'Opslaan mislukt.' }, fetchImpl), { message: 'Opslaan mislukt. (HTTP 500)' })
  }
  const { fetchImpl } = fake(() => json({}, 500))
  await assert.rejects(api('/api/x', {}, fetchImpl), { message: 'Het verzoek is mislukt. (HTTP 500)' })
})

test('an unreachable server is an ApiError with status 0', async () => {
  const { fetchImpl } = fake(() => Promise.reject(new TypeError('fetch failed')))
  await assert.rejects(api('/api/x', {}, fetchImpl), (error) => error instanceof ApiError && error.status === 0 && error.message === 'De server is niet bereikbaar.')
})

test('a success that is not JSON is an error, not an empty screen', async () => {
  for (const reply of [() => new Response('ok', { status: 200 }), () => new Response('', { status: 200 })]) {
    const { fetchImpl } = fake(reply)
    await assert.rejects(api('/api/x', {}, fetchImpl), { message: 'Onverwacht antwoord van de server.' })
  }
})
