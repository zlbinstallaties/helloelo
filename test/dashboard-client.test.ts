import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardParams, requestDashboard } from '../src/lib/dashboard-client.ts'
import type { DashboardResponse } from '../src/lib/dashboard-types.ts'

const RESPONSE: DashboardResponse = {
  company: { id: 2, name: 'Test' },
  appointments: [],
  technicians: [],
  scope: 'day',
  date: '2026-10-06',
  loadedAt: '2026-10-06T08:00:00.000Z',
}

type Call = { url: string; method: string | undefined }

function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method })
    return reply()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('the query string has date and scope, and a technician only when one is chosen', () => {
  assert.equal(dashboardParams('2026-10-06', 'day', '').toString(), 'date=2026-10-06&scope=day')
  assert.equal(
    dashboardParams('2026-10-06', 'upcoming', 'employee:7').toString(),
    'date=2026-10-06&scope=upcoming&technician=employee%3A7',
  )
})

test('a reload is a GET and a refresh is a POST of the same address', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json(RESPONSE))
  const params = dashboardParams('2026-10-06', 'day', '')
  assert.deepEqual(await requestDashboard(params, 'GET', 'x', fetchImpl), RESPONSE)
  assert.deepEqual(await requestDashboard(params, 'POST', 'x', fetchImpl), RESPONSE)
  assert.deepEqual(calls, [
    { url: '/api/dashboard?date=2026-10-06&scope=day', method: 'GET' },
    { url: '/api/dashboard?date=2026-10-06&scope=day', method: 'POST' },
  ])
})

test('an error answer of the server becomes the message that is shown', async () => {
  const { fetchImpl } = fakeFetch(() => json({ error: 'Odoo-gateway is niet bereikbaar.' }, 502))
  await assert.rejects(
    requestDashboard(dashboardParams('2026-10-06', 'day', ''), 'POST', 'De gegevens konden niet worden vernieuwd.', fetchImpl),
    { message: 'Odoo-gateway is niet bereikbaar.' },
  )
})

test('an error without a usable body gets the fallback message and the status', async () => {
  const params = dashboardParams('2026-10-06', 'day', '')
  const html = fakeFetch(() => new Response('<h1>Er ging iets mis</h1>', { status: 500 }))
  await assert.rejects(requestDashboard(params, 'POST', 'Vernieuwen mislukt.', html.fetchImpl), {
    message: 'Vernieuwen mislukt. (HTTP 500)',
  })
  const empty = fakeFetch(() => json({ error: '' }, 503))
  await assert.rejects(requestDashboard(params, 'GET', 'Laden mislukt.', empty.fetchImpl), {
    message: 'Laden mislukt. (HTTP 503)',
  })
})

test('a server that cannot be reached is reported as such', async () => {
  const { fetchImpl } = fakeFetch(() => Promise.reject(new TypeError('fetch failed')))
  await assert.rejects(requestDashboard(dashboardParams('2026-10-06', 'day', ''), 'POST', 'x', fetchImpl), {
    message: 'De server is niet bereikbaar.',
  })
})

test('a success answer that is not a dashboard answer is an error, not an empty screen', async () => {
  const params = dashboardParams('2026-10-06', 'day', '')
  for (const body of [{}, { appointments: 'nee' }, null]) {
    const { fetchImpl } = fakeFetch(() => json(body))
    await assert.rejects(requestDashboard(params, 'POST', 'x', fetchImpl), { message: 'Onverwacht antwoord van de server.' })
  }
  const text = fakeFetch(() => new Response('ok', { status: 200 }))
  await assert.rejects(requestDashboard(params, 'POST', 'x', text.fetchImpl), { message: 'Onverwacht antwoord van de server.' })
})
