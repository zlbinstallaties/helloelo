import test from 'node:test'
import assert from 'node:assert/strict'
import { allFields, FORMS } from '../src/lib/documents/forms.ts'
import { extractFacts } from '../src/lib/documents/facts.ts'
import { validateSubmission } from '../src/lib/documents/submission.ts'
import { OPLEVERING_MONOBLOCK, OPLEVERING_OVERIG, OPLEVERING_SPLIT, SCHOUW_ANSWERS, SIGNATURE } from './documents-fixtures.ts'

const signature = { name: 'Mevr. Jansen', image: SIGNATURE }

function factsOf(form: typeof FORMS.schouw, answers: Record<string, unknown>) {
  const result = validateSubmission(form, { author: 'Jan', answers, signature })
  assert.ok(result.ok, JSON.stringify(result.ok ? {} : result.errors))
  return extractFacts(form, result.value.answers)
}

test('facts: the keys are unique, plain names, and sit on fields that can have them', () => {
  for (const form of Object.values(FORMS)) {
    const keys: string[] = []
    for (const field of allFields(form)) {
      if (!field.fact) continue
      assert.match(field.fact.key, /^[a-z][a-z0-9_]*$/, field.id)
      assert.notEqual(field.kind, 'photos', `${field.id}: a photo is no fact`)
      keys.push(field.fact.key)
      if (field.fact.values) {
        assert.equal(field.kind, 'choice', `${field.id}: only a choice maps values`)
        if (field.kind === 'choice') {
          const options = field.options.map((option) => option.value)
          for (const value of Object.keys(field.fact.values)) assert.ok(options.includes(value), `${field.id}: ${value} is no option`)
        }
      }
    }
    assert.equal(new Set(keys).size, keys.length, `${form.type}: a fact key is used twice`)
  }
})

test('schouw: what the offerte engine asks for comes out under its own words', () => {
  const result = factsOf(FORMS.schouw, {
    ...SCHOUW_ANSWERS,
    werkzaamheden: 'warmtepomp_hybride',
    isolatie: 'matig',
    personen: '3',
    gasverbruik: '1450',
    bouwjaar: '1985',
    afgifte: 'lt_radiatoren',
    ruimte_installatie: 'voldoende',
    boiler_opstelling: 'staand',
    trace_lengte: '12,5',
    trace_toelichting: '  Doorvoer naast de keuken  ',
    aansluiting: '3-fase',
    graafwerk_klant: { value: 'ja', note: 'Sleuf achtertuin.' },
  })
  assert.equal(result.schema, 'dig.facts/1')
  assert.equal(result.form, 'schouw')
  assert.equal(result.formVersion, 2)
  assert.deepEqual(result.facts, {
    gewenst_systeem: 'hybride',
    ruimte_installatie: 'voldoende',
    boiler_opstelling: 'staand',
    bouwjaar: 1985,
    isolatie: 'matig',
    aantal_personen: 3,
    gasverbruik_m3_per_jaar: 1450,
    asbest_vermoed: false,
    leidinglengte_m: 12.5,
    leidingroute: 'Doorvoer naast de keuken',
    aansluiting: '3-fase',
    afgiftesysteem: 'lt_radiatoren',
    graafwerk_door_klant: true,
    stroom_door_klant: false,
    werkruimte_door_klant: false,
    schouw_compleet: true,
  })
})

test('schouw: unknown, not applicable and not answered are no facts; the system follows the installation type', () => {
  const none = factsOf(FORMS.schouw, { ...SCHOUW_ANSWERS, isolatie: 'onbekend', afgifte: 'nvt', aansluiting: 'onbekend', groep_vrij: 'onbekend', ruimte_installatie: 'onbekend' }).facts
  for (const key of ['isolatie', 'afgiftesysteem', 'aansluiting', 'groep_vrij', 'ruimte_installatie', 'ruimte_meterkast', 'gewenst_systeem', 'aantal_personen', 'leidinglengte_m']) {
    assert.equal(key in none, false, `${key} must not be a fact`)
  }
  assert.equal(factsOf(FORMS.schouw, { ...SCHOUW_ANSWERS, werkzaamheden: 'warmtepomp_all_electric' }).facts.gewenst_systeem, 'all-electric')
  assert.equal('gewenst_systeem' in factsOf(FORMS.schouw, { ...SCHOUW_ANSWERS, werkzaamheden: 'airco' }).facts, false, 'an air conditioner is no heat pump system for the engine')
  assert.equal(factsOf(FORMS.schouw, { ...SCHOUW_ANSWERS, groep_vrij: 'ja', meterkast: { value: 'ja' } }).facts.groep_vrij, true)
  assert.equal(factsOf(FORMS.schouw, { ...SCHOUW_ANSWERS, groep_vrij: 'nee', meterkast: { value: 'nee', note: 'Te krap.' } }).facts.ruimte_meterkast, false)
})

test('oplevering: the equipment goes to the customer, only the part that applies, and only what was answered', () => {
  const monoblock = factsOf(FORMS.oplevering, { ...OPLEVERING_MONOBLOCK, serienummer_binnen: 'SN-0002', sp_lading: '1,2' }).facts
  assert.deepEqual(monoblock, {
    systeem_type: 'monoblock',
    apparaat_merk: 'Testmerk',
    apparaat_model: 'T-100',
    serienummer_buitenunit: 'SN-0001',
    serienummer_binnenunit: 'SN-0002',
    inbedrijfstelling_datum: '2026-10-08',
  })
  const split = factsOf(FORMS.oplevering, { ...OPLEVERING_SPLIT, sp_koudemiddel: 'R32', sp_lading: '1,2', sp_leidinglengte: '7' }).facts
  assert.equal(split.systeem_type, 'split')
  assert.equal(split.koudemiddel_type, 'R32')
  assert.equal(split.koudemiddel_kg, 1.2)
  assert.equal(split.koudemiddelleiding_m, 7)
  assert.deepEqual(factsOf(FORMS.oplevering, { ...OPLEVERING_OVERIG, merk: 'Testmerk' }).facts, {}, 'no commissioning, no equipment facts')
})
