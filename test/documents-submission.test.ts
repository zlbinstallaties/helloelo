import test from 'node:test'
import assert from 'node:assert/strict'
import { allFields, DOCUMENT_TYPES, FORMS, isDocumentType } from '../src/lib/documents/forms.ts'
import { dataUrlToBytes, parseJpeg } from '../src/lib/documents/jpeg.ts'
import { FORM_ERROR, LIMITS, validateSubmission } from '../src/lib/documents/submission.ts'
import { GRAY, PHOTO, SIGNATURE } from './documents-fixtures.ts'

const signature = { name: 'Jan de Vries', image: SIGNATURE }

/** Valid answers for every required field of the schouw form. */
function schouwAnswers(overrides: Record<string, unknown> = {}) {
  return {
    parkeren: { value: 'ja' },
    huisdieren: { value: 'nee' },
    werkzaamheden: 'warmtepomp',
    meterkast: { value: 'ja' },
    asbest: { value: 'nee' },
    ...overrides,
  }
}

test('forms: ids are unique, choices are valid and every form can be filled in', () => {
  assert.deepEqual([...DOCUMENT_TYPES].sort(), ['oplevering', 'schouw'])
  for (const form of Object.values(FORMS)) {
    const ids = allFields(form).map((field) => field.id)
    assert.equal(new Set(ids).size, ids.length, `${form.type}: duplicate field id`)
    assert.ok(form.sections.length > 0 && form.signatureStatement)
    for (const field of allFields(form)) {
      assert.match(field.id, /^[a-z][a-z0-9_]*$/, field.id)
      if (field.kind === 'choice') {
        const values = field.options.map((option) => option.value)
        assert.ok(values.length > 1 && new Set(values).size === values.length, field.id)
      }
      if (field.kind === 'photos') assert.ok(field.max >= 1 && field.max <= 12, field.id)
    }
  }
  assert.ok(isDocumentType('schouw') && !isDocumentType('x') && !isDocumentType(undefined))
})

test('a complete schouw is accepted and optional empty fields are left out', () => {
  const result = validateSubmission(FORMS.schouw, { author: ' Piet Monteur ', answers: schouwAnswers(), signature })
  assert.ok(result.ok)
  assert.equal(result.value.author, 'Piet Monteur')
  assert.deepEqual(result.value.answers.parkeren, { value: 'ja', note: '' })
  assert.equal(result.value.answers.werkzaamheden, 'warmtepomp')
  assert.equal('toegang' in result.value.answers, false)
  assert.equal('fotos_situatie' in result.value.answers, false)
})

test('required fields, author and signature are reported by key', () => {
  const result = validateSubmission(FORMS.schouw, { answers: {}, signature: {} })
  assert.ok(!result.ok)
  for (const key of ['parkeren', 'huisdieren', 'werkzaamheden', 'meterkast', 'asbest', 'author', 'signature.name', 'signature.image']) {
    assert.ok(key in result.errors, key)
  }
  assert.equal(result.errors['signature.image'], 'De klant moet nog tekenen.')
  assert.ok(!validateSubmission(FORMS.schouw, null).ok, 'null input is just invalid')
  assert.ok(!validateSubmission(FORMS.schouw, 'x').ok)
})

test('an explanation is required for the answer that asks for one, and dropped for the other', () => {
  const missing = validateSubmission(FORMS.schouw, { author: 'Piet', answers: schouwAnswers({ asbest: { value: 'ja' } }), signature })
  assert.ok(!missing.ok)
  assert.equal(missing.errors.asbest, 'Geef een toelichting.')

  const given = validateSubmission(FORMS.schouw, { author: 'Piet', answers: schouwAnswers({ asbest: { value: 'ja', note: ' Golfplaten achter de schuur ' } }), signature })
  assert.ok(given.ok)
  assert.deepEqual(given.value.answers.asbest, { value: 'ja', note: 'Golfplaten achter de schuur' })

  // Changing the answer back to "nee" must not keep the old note.
  const changed = validateSubmission(FORMS.schouw, { author: 'Piet', answers: schouwAnswers({ asbest: { value: 'nee', note: 'oud' } }), signature })
  assert.ok(changed.ok)
  assert.deepEqual(changed.value.answers.asbest, { value: 'nee', note: '' })
})

test('"niet van toepassing" is only accepted where the field allows it', () => {
  const allowed = validateSubmission(FORMS.schouw, { author: 'Piet', answers: schouwAnswers({ meterkast: { value: 'nvt' } }), signature })
  assert.ok(allowed.ok)
  const refused = validateSubmission(FORMS.schouw, { author: 'Piet', answers: schouwAnswers({ parkeren: { value: 'nvt' } }), signature })
  assert.ok(!refused.ok)
  assert.equal(refused.errors.parkeren, 'Kies een van de opties.')
})

test('choices, numbers, text length and unknown ids', () => {
  const bad = validateSubmission(FORMS.schouw, {
    author: 'Piet',
    signature,
    answers: schouwAnswers({ werkzaamheden: 'tuinhuis', bouwjaar: '19x5', toegang: 'x'.repeat(LIMITS.textarea + 1) }),
  })
  assert.ok(!bad.ok)
  assert.equal(bad.errors.werkzaamheden, 'Kies een van de opties.')
  assert.equal(bad.errors.bouwjaar, 'Vul een getal in.')
  assert.match(bad.errors.toegang, /Maximaal/)

  const good = validateSubmission(FORMS.schouw, {
    author: 'Piet',
    signature,
    answers: schouwAnswers({ bouwjaar: ' 1975 ', ruimte: 'Zolder, 3,5 m', onbekend: 'moet weg' }),
  })
  assert.ok(good.ok)
  assert.equal(good.value.answers.bouwjaar, '1975')
  assert.equal('onbekend' in good.value.answers, false)
})

test('photos must be small JPEG data URLs within the limits of the field', () => {
  const ok = validateSubmission(FORMS.schouw, { author: 'Piet', signature, answers: schouwAnswers({ fotos_situatie: [PHOTO, GRAY] }) })
  assert.ok(ok.ok)
  assert.equal((ok.value.answers.fotos_situatie as string[]).length, 2)

  const cases: Array<[string, unknown]> = [
    ['not an array', PHOTO],
    ['wrong type', ['data:image/png;base64,AAAA']],
    ['not base64', ['data:image/jpeg;base64,@@@@']],
    ['a script', ['data:image/jpeg;base64,AAAA<script>']],
    ['too big', [`data:image/jpeg;base64,${'A'.repeat(LIMITS.photoChars)}`]],
    ['too many for the field', Array(9).fill(PHOTO)],
  ]
  for (const [name, photos] of cases) {
    const result = validateSubmission(FORMS.schouw, { author: 'Piet', signature, answers: schouwAnswers({ fotos_situatie: photos }) })
    assert.ok(!result.ok, name)
    assert.ok('fotos_situatie' in result.errors, name)
  }
})

test('the signature needs a name and a JPEG image', () => {
  const noName = validateSubmission(FORMS.oplevering, { author: 'Piet', answers: {}, signature: { name: ' ', image: SIGNATURE } })
  assert.ok(!noName.ok && noName.errors['signature.name'])
  const badImage = validateSubmission(FORMS.oplevering, { author: 'Piet', answers: {}, signature: { name: 'Klant', image: 'javascript:alert(1)' } })
  assert.ok(!badImage.ok && badImage.errors['signature.image'])
  assert.ok(FORM_ERROR.startsWith('_'))
})

test('the oplevering form needs its own required answers', () => {
  const result = validateSubmission(FORMS.oplevering, { author: 'Piet', answers: {}, signature })
  assert.ok(!result.ok)
  assert.deepEqual(
    Object.keys(result.errors).sort(),
    ['getest', 'instructie', 'opgeruimd', 'uitgevoerd', 'volledig'].sort(),
  )
})

test('jpeg: reads size and channels, refuses everything else', () => {
  const photo = dataUrlToBytes(PHOTO)
  assert.ok(photo)
  assert.deepEqual(parseJpeg(photo), { width: 96, height: 64, components: 3 })
  const gray = dataUrlToBytes(GRAY)
  assert.deepEqual(gray && parseJpeg(gray), { width: 40, height: 30, components: 1 })

  assert.equal(dataUrlToBytes('data:image/png;base64,AAAA'), null)
  assert.equal(dataUrlToBytes('data:image/jpeg;base64,***'), null)
  assert.equal(parseJpeg(new Uint8Array([1, 2, 3, 4, 5])), null)
  assert.equal(parseJpeg(photo.slice(0, photo.length - 10)), null, 'a cut-off file')
  assert.equal(parseJpeg(photo.slice(0, 30)), null)
  assert.equal(parseJpeg(new Uint8Array()), null)
})
