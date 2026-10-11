import test from 'node:test'
import assert from 'node:assert/strict'
import { setCustomerFactsViaGateway } from '../src/lib/gateway-customer-facts.ts'

const REFERENCE = { model: 'planning.slot', id: 12 } as const
const FACTS = { isolatie: 'matig', aantal_personen: 3 }
const base = { url: 'http://gateway.local:8070', token: 'dashboard-token', requestId: 'facts-0123456789abcdef', reference: REFERENCE, facts: FACTS }

type Seen = { url: string; init: RequestInit }
const answering = (status: number, body: unknown, seen: Seen[] = []): typeof fetch =>
  (async (url: unknown, init: RequestInit) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch

test('the request has the request id, the reference and the facts, and nothing else: no customer, no Odoo field, no model to write to', async () => {
  const seen: Seen[] = []
  const outcome = await setCustomerFactsViaGateway({ ...base, fetchImpl: answering(200, { written: ['isolatie'], kept: ['aantal_personen'], customer: 'Familie Van den Berg', replayed: false }, seen) })
  assert.equal(seen[0].url, 'http://gateway.local:8070/v1/actions/set_customer_facts')
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, 'Bearer dashboard-token')
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { requestId: base.requestId, reference: REFERENCE, facts: FACTS })
  assert.deepEqual(outcome, { ok: true, written: ['isolatie'], kept: ['aantal_personen'], customer: 'Familie Van den Berg', replayed: false })
})

test('what the gateway answers is sorted by what it allows next', async () => {
  const cases: Array<[number, unknown, string, string]> = [
    [403, { error: 'action_not_allowed' }, 'not_enabled', 'staat niet aan'],
    [409, { error: 'fields_not_installed' }, 'not_installed', 'dig_schouw_facts'],
    [404, { error: 'reference_not_found' }, 'rejected', 'niet gevonden'],
    [409, { error: 'reference_has_no_customer' }, 'rejected', 'geen klant'],
    [429, { error: 'rate_limited' }, 'rejected', 'te veel'],
    [400, { error: 'invalid_facts' }, 'rejected', 'invalid_facts'],
    [502, { error: 'odoo_rejected', message: 'odoo.exceptions.AccessError' }, 'rejected', 'odoo.exceptions.AccessError'],
    [502, { error: 'odoo_error', message: 'odoo.exceptions.UserError' }, 'rejected', 'fout'],
    [504, { error: 'outcome_unknown' }, 'unknown', 'niet zeker'],
    [409, { error: 'in_progress' }, 'unknown', 'niet zeker'],
    [500, { error: 'internal_error' }, 'unknown', 'niet zeker'],
    [200, { written: 'x' }, 'unknown', 'niet zeker'],
  ]
  for (const [status, body, kind, text] of cases) {
    const outcome = await setCustomerFactsViaGateway({ ...base, fetchImpl: answering(status, body) })
    assert.equal(outcome.ok, false, `${status}`)
    if (!outcome.ok) {
      assert.equal(outcome.kind, kind, `${status} ${JSON.stringify(body)}`)
      assert.ok(outcome.message.includes(text), `${status}: ${outcome.message}`)
    }
  }
})

test('the free text of Odoo is not passed on: only a plain class name or status is', async () => {
  const outcome = await setCustomerFactsViaGateway({ ...base, fetchImpl: answering(502, { error: 'odoo_rejected', message: 'Klant Jansen, Kerkstraat 12 bestaat al' }) })
  assert.ok(!outcome.ok && !outcome.message.includes('Jansen') && !outcome.message.includes('Kerkstraat'))
})

test('a gateway that does not answer in time, or fails, is unknown, not an endless wait', async () => {
  const hanging = (() => new Promise(() => {})) as unknown as typeof fetch
  const slow = await setCustomerFactsViaGateway({ ...base, fetchImpl: hanging, timeoutMs: 30 })
  assert.ok(!slow.ok && slow.kind === 'unknown')
  const broken = await setCustomerFactsViaGateway({ ...base, fetchImpl: (async () => { throw new TypeError('connection reset') }) as unknown as typeof fetch })
  assert.ok(!broken.ok && broken.kind === 'unknown')
})

test('a reference or facts that are wrong never leave the dashboard', async () => {
  const seen: Seen[] = []
  const fetchImpl = answering(200, { written: [], kept: [] }, seen)
  for (const change of [
    { reference: { model: 'res.partner', id: 1 } }, { reference: { model: 'planning.slot', id: 0 } }, { reference: { model: 'planning.slot', id: 1.5 } },
    { facts: {} }, { facts: { name: 'x' } }, { facts: { isolatie: 'perfect' } }, { facts: { aantal_personen: 99 } },
  ]) {
    const outcome = await setCustomerFactsViaGateway({ ...base, ...change, fetchImpl } as Parameters<typeof setCustomerFactsViaGateway>[0])
    assert.ok(!outcome.ok && outcome.kind === 'rejected', JSON.stringify(change))
  }
  assert.equal(seen.length, 0)
})
