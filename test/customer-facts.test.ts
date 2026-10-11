import test from 'node:test'
import assert from 'node:assert/strict'
import { allFields, FORMS } from '../src/lib/documents/forms.ts'
import { CUSTOMER_FACTS, CUSTOMER_FACT_FIELDS, checkCustomerFact, customerFactSpec, toCustomerFacts, validateCustomerFacts } from '../src/lib/documents/customer-facts.ts'
import { extractFacts } from '../src/lib/documents/facts.ts'
import { validateSubmission } from '../src/lib/documents/submission.ts'
import { OPLEVERING_MONOBLOCK, SCHOUW_ANSWERS, SIGNATURE } from './documents-fixtures.ts'

function schouwFacts(answers: Record<string, unknown>) {
  const result = validateSubmission(FORMS.schouw, { author: 'Jan', answers, signature: { name: 'Mevr. Jansen', image: SIGNATURE } })
  assert.ok(result.ok, JSON.stringify(result.ok ? {} : result.errors))
  return extractFacts(FORMS.schouw, result.value.answers)
}

test('the table: keys and Odoo fields are unique, plain names, and every field is a dig_ field of the module', () => {
  assert.equal(new Set(CUSTOMER_FACTS.map((spec) => spec.key)).size, CUSTOMER_FACTS.length)
  assert.equal(new Set(CUSTOMER_FACT_FIELDS).size, CUSTOMER_FACT_FIELDS.length)
  for (const spec of CUSTOMER_FACTS) {
    assert.match(spec.key, /^[a-z][a-z0-9_]*$/, spec.key)
    assert.match(spec.field, /^dig_schouw_[a-z0-9_]+$/, spec.field)
    if (spec.type === 'selection') assert.ok(spec.options.length >= 2 && new Set(spec.options).size === spec.options.length, spec.key)
  }
})

test('the table and the schouw form agree: every fact of the schouw goes to the customer, and the table holds nothing the form does not make', () => {
  const formKeys = allFields(FORMS.schouw).flatMap((field) => (field.fact ? [field.fact.key] : []))
  const tableKeys = CUSTOMER_FACTS.map((spec) => spec.key).filter((key) => key !== 'schouw_datum')
  assert.deepEqual([...formKeys].sort(), [...tableKeys].sort())
  // The values a form can make are values the table accepts.
  for (const field of allFields(FORMS.schouw)) {
    if (!field.fact || field.kind !== 'choice') continue
    const spec = customerFactSpec(field.fact.key)
    assert.equal(spec?.type, 'selection', field.id)
    for (const option of field.options) {
      const made = field.fact.values ? field.fact.values[option.value] : ['onbekend', 'nvt'].includes(option.value) ? null : option.value
      if (made === null || made === undefined) continue
      assert.notEqual(checkCustomerFact(spec!, typeof made === 'boolean' ? (made ? 'ja' : 'nee') : made), null, `${field.id}=${option.value}`)
    }
  }
})

test('a schouw becomes the facts of the customer: yes and no are "ja" and "nee", numbers stay numbers, and the day of the schouw is added', () => {
  const source = schouwFacts({
    ...SCHOUW_ANSWERS,
    werkzaamheden: 'warmtepomp_hybride', isolatie: 'matig', personen: '3', gasverbruik: '1450', bouwjaar: '1985', afgifte: 'lt_radiatoren', trace_lengte: '12,5',
    trace_toelichting: 'Doorvoer naast de keuken', aansluiting: '3-fase', graafwerk_klant: { value: 'ja', note: 'Sleuf.' },
  })
  const { facts, skipped } = toCustomerFacts(source, '2026-10-12')
  assert.deepEqual(skipped, [])
  assert.deepEqual(facts, {
    gewenst_systeem: 'hybride', afgiftesysteem: 'lt_radiatoren', isolatie: 'matig', aantal_personen: 3, bouwjaar: 1985, gasverbruik_m3_per_jaar: 1450, leidinglengte_m: 12.5,
    leidingroute: 'Doorvoer naast de keuken', aansluiting: '3-fase', asbest_vermoed: 'nee', graafwerk_door_klant: 'ja', stroom_door_klant: 'nee', werkruimte_door_klant: 'nee',
    schouw_compleet: 'ja', schouw_datum: '2026-10-12',
  })
})

test('a value the table does not accept is left out and counted, never sent; an oplevering gives nothing for the customer', () => {
  const source = schouwFacts({ ...SCHOUW_ANSWERS, personen: '99', bouwjaar: '1200', isolatie: 'goed' })
  const { facts, skipped } = toCustomerFacts(source, '2026-10-12')
  assert.deepEqual(skipped.sort(), ['aantal_personen', 'bouwjaar'])
  assert.equal('aantal_personen' in facts, false)
  assert.equal(facts.isolatie, 'goed')
  const oplevering = validateSubmission(FORMS.oplevering, { author: 'Jan', answers: OPLEVERING_MONOBLOCK, signature: { name: 'Mevr. Jansen', image: SIGNATURE } })
  assert.ok(oplevering.ok)
  assert.deepEqual(toCustomerFacts(extractFacts(FORMS.oplevering, oplevering.value.answers), '2026-10-12'), { facts: {}, skipped: [] })
  // No facts, no date: a date alone says nothing.
  const none = toCustomerFacts({ schema: 'dig.facts/1', form: 'schouw', formVersion: 2, facts: {} }, '2026-10-12')
  assert.deepEqual(none.facts, {})
  // A date that is not one is not sent either.
  assert.equal('schouw_datum' in toCustomerFacts(source, '2026-02-30').facts, false)
})

test('validateCustomerFacts: only keys of the table with valid values; one wrong value refuses all; nothing else of a customer can be named', () => {
  assert.deepEqual(validateCustomerFacts({ isolatie: 'goed', aantal_personen: 2 }), { ok: true, facts: { isolatie: 'goed', aantal_personen: 2 } })
  for (const input of [null, [], 'x', {}, { name: 'x' }, { email: 'x@y.nl' }, { parent_id: 1 }, { dig_schouw_isolatie: 'goed' }, { isolatie: 'perfect' }, { isolatie: 'goed', aantal_personen: 21 }, { leidingroute: '' }, { leidingroute: 'a\u0000b' }]) {
    assert.equal(validateCustomerFacts(input).ok, false, JSON.stringify(input))
  }
  assert.ok(validateCustomerFacts({ leidingroute: 'Regel een\nregel twee' }).ok, 'a text may have line breaks')
  assert.equal(checkCustomerFact(customerFactSpec('bouwjaar')!, 1985.5), null)
  assert.equal(checkCustomerFact(customerFactSpec('gasverbruik_m3_per_jaar')!, Number.NaN), null)
  assert.equal(checkCustomerFact(customerFactSpec('schouw_datum')!, '2026-10-12'), '2026-10-12')
})
