import assert from 'node:assert/strict'
import test from 'node:test'
import { FORMS } from '../src/lib/documents/forms.ts'
import type { PhotosField, YesNoField } from '../src/lib/documents/forms.ts'
import {
  addPhoto, canAddPhoto, DRAFT_MAX_AGE_MS, draftKey, emptyDraft, firstErrorId, newSubmissionId, parseDraft, removePhoto, setNote, setSignatureImage,
  setSignatureName, setText, setYesNo, toPayload, validateDraft,
} from '../src/lib/documents/form-state.ts'
import { LIMITS } from '../src/lib/documents/submission.ts'
import { PHOTO, SIGNATURE } from './documents-fixtures.ts'

const NOW = new Date('2026-10-08T09:30:00Z')
const schouw = FORMS.schouw
const field = <T>(id: string) => schouw.sections.flatMap((section) => [...section.fields]).find((item) => item.id === id) as T

/** A draft that is complete for the schouw. */
function complete() {
  let draft = emptyDraft('f3b1c2d4-5e6f-4a7b-8c9d-0123456789ab', NOW)
  draft = setYesNo(draft, field<YesNoField>('parkeren'), 'ja')
  draft = setYesNo(draft, field<YesNoField>('huisdieren'), 'nee')
  draft = setText(draft, 'werkzaamheden', 'sanitair')
  draft = setYesNo(draft, field<YesNoField>('meterkast'), 'nvt')
  draft = setYesNo(draft, field<YesNoField>('asbest'), 'nee')
  draft = setSignatureName(draft, 'Mevr. Klant')
  return setSignatureImage(draft, SIGNATURE)
}

test('a new submission number is a long random id the server accepts', () => {
  const first = newSubmissionId()
  assert.match(first, /^[A-Za-z0-9-]{16,64}$/)
  assert.notEqual(first, newSubmissionId())
})

test('an empty draft has every required field wrong, in the order of the screen, and the signature last', () => {
  const errors = validateDraft(schouw, emptyDraft('a-submission-0000001', NOW), 'Jan de Vries')
  assert.deepEqual(Object.keys(errors), ['parkeren', 'huisdieren', 'werkzaamheden', 'meterkast', 'asbest', 'signature.name', 'signature.image'])
  assert.equal(firstErrorId(schouw, errors), 'parkeren')
})

test('a complete draft is fine; changes are copies, the old draft stays as it was', () => {
  const before = emptyDraft('a-submission-0000001', NOW)
  const after = setText(before, 'werkzaamheden', 'sanitair')
  assert.deepEqual(before.answers, {})
  assert.equal(after.answers.werkzaamheden, 'sanitair')
  assert.deepEqual(validateDraft(schouw, complete(), 'Jan de Vries'), {})
})

test('yes or no keeps a note only for the answer it explains; changing the answer drops a note that no longer fits', () => {
  const parkeren = field<YesNoField>('parkeren') // explains "nee"
  let draft = setYesNo(emptyDraft('a-submission-0000001', NOW), parkeren, 'nee')
  draft = setNote(draft, 'parkeren', 'Alleen betaald parkeren.')
  assert.deepEqual(draft.answers.parkeren, { value: 'nee', note: 'Alleen betaald parkeren.' })
  draft = setYesNo(draft, parkeren, 'ja')
  assert.deepEqual(draft.answers.parkeren, { value: 'ja', note: '' }, 'the note of "nee" is gone with "nee"')
  draft = setYesNo(draft, parkeren, 'nee')
  assert.deepEqual(draft.answers.parkeren, { value: 'nee', note: '' }, 'and it does not come back')
  const errors = validateDraft(schouw, { ...complete(), answers: { ...complete().answers, parkeren: draft.answers.parkeren } }, 'Jan')
  assert.deepEqual(Object.keys(errors), ['parkeren'], 'an explanation is asked for')
  assert.equal(errors.parkeren, 'Geef een toelichting.')
})

test('a choice that is not an option, a bad number and a bad date are caught on the phone with the same rules as on the server', () => {
  let draft = complete()
  draft = setText(draft, 'werkzaamheden', 'tuinhuis')
  draft = setText(draft, 'bouwjaar', 'negentien')
  assert.deepEqual(Object.keys(validateDraft(schouw, draft, 'Jan')), ['werkzaamheden', 'bouwjaar'])
})

test('photos: added up to the maximum of the field, removed by place, and never more than the total of the form', () => {
  const fotos = field<PhotosField>('fotos_situatie')
  let draft = complete()
  for (let index = 0; index < fotos.max; index++) {
    assert.equal(canAddPhoto(schouw, draft, fotos), true)
    draft = addPhoto(schouw, draft, fotos, PHOTO)
  }
  assert.equal((draft.answers.fotos_situatie as string[]).length, fotos.max)
  assert.equal(canAddPhoto(schouw, draft, fotos), false)
  assert.equal(addPhoto(schouw, draft, fotos, PHOTO), draft, 'at the maximum nothing changes')
  draft = removePhoto(draft, 'fotos_situatie', 0)
  assert.equal((draft.answers.fotos_situatie as string[]).length, fotos.max - 1)
  assert.equal(canAddPhoto(schouw, draft, fotos), true)
  assert.ok(fotos.max <= LIMITS.photosTotal)
  assert.equal(addPhoto(schouw, complete(), fotos, 'data:image/png;base64,AAAA').answers.fotos_situatie, undefined, 'only a JPEG is a photo')
  draft = removePhoto(removePhoto(draft, 'fotos_situatie', 99), 'nope', 0)
  assert.equal((draft.answers.fotos_situatie as string[]).length, fotos.max - 1, 'a place that is not there changes nothing')
})

test('the signature needs a name and a drawing, and each is pointed at on its own', () => {
  assert.deepEqual(Object.keys(validateDraft(schouw, setSignatureImage(complete(), ''), 'Jan')), ['signature.image'])
  assert.deepEqual(Object.keys(validateDraft(schouw, setSignatureName(complete(), ' '), 'Jan')), ['signature.name'])
  assert.equal(firstErrorId(schouw, { 'signature.image': 'x', 'signature.name': 'y' }), 'signature.name')
})

test('the payload has the fields of the form that were answered, trimmed, and no author: the server knows who is logged in', () => {
  let draft = complete()
  draft = setText(draft, 'ruimte', '  Badkamer 2,4 x 1,8 m.  ')
  draft = setText(draft, 'toegang', '')
  draft = setText(draft, 'bestaat-niet', 'x')
  const payload = toPayload(schouw, draft, 'slot-12')
  assert.deepEqual(Object.keys(payload).sort(), ['answers', 'appointmentId', 'signature', 'submissionId', 'type'])
  assert.equal(payload.type, 'schouw')
  assert.equal(payload.appointmentId, 'slot-12')
  assert.equal(payload.submissionId, draft.submissionId)
  assert.equal(payload.answers.ruimte, 'Badkamer 2,4 x 1,8 m.')
  assert.ok(!('toegang' in payload.answers), 'an empty text is not sent')
  assert.ok(!('bestaat-niet' in payload.answers), 'a field that is not in the form is not sent')
  assert.deepEqual(payload.signature, { name: 'Mevr. Klant', image: SIGNATURE })
})

test('what is stored is read back only when it is a draft of this version, not too old, and then only with fields of the form', () => {
  const stored = JSON.parse(JSON.stringify({ ...complete(), answers: { ...complete().answers, ruimte: 'x', 'weg-ermee': 'y', toegang: 12, parkeren: { value: 'misschien', note: 3 }, fotos_situatie: [PHOTO, 'data:image/png;base64,AA', 7] } }))
  const read = parseDraft(stored, schouw, NOW)
  assert.ok(read)
  assert.equal(read.answers.ruimte, 'x')
  assert.ok(!('weg-ermee' in read.answers), 'a field of an older form is dropped')
  assert.ok(!('toegang' in read.answers), 'a wrong shape is dropped')
  assert.ok(!('parkeren' in read.answers))
  assert.deepEqual(read.answers.fotos_situatie, [PHOTO], 'only real photos are kept')
  assert.equal(read.signature.image, SIGNATURE)
  const crowded = parseDraft({ ...stored, answers: { fotos_situatie: Array.from({ length: 11 }, () => PHOTO) } }, schouw, NOW)
  assert.ok(crowded)
  assert.equal((crowded.answers.fotos_situatie as string[]).length, 8, 'no more photos come back than the field allows')
  for (const broken of [null, 'x', [], {}, { ...stored, signature: { name: 'x', image: 'data:image/png;base64,AAAA' } }, { ...stored, version: 2 }, { ...stored, submissionId: 'short' }, { ...stored, signature: 'x' }, { ...stored, savedAt: 'gisteren' }]) {
    assert.equal(parseDraft(broken, schouw, NOW), null, JSON.stringify(broken)?.slice(0, 50))
  }
  const old = { ...stored, savedAt: new Date(NOW.getTime() - DRAFT_MAX_AGE_MS - 1000).toISOString() }
  assert.equal(parseDraft(old, schouw, NOW), null, 'a draft of weeks ago is not brought back')
  assert.ok(parseDraft({ ...stored, savedAt: new Date(NOW.getTime() - DRAFT_MAX_AGE_MS + 60_000).toISOString() }, schouw, NOW))
})

test('a draft belongs to one person, one kind of document and one appointment', () => {
  assert.notEqual(draftKey('acc-1', 'schouw', 'slot-12'), draftKey('acc-2', 'schouw', 'slot-12'))
  assert.notEqual(draftKey('acc-1', 'schouw', 'slot-12'), draftKey('acc-1', 'oplevering', 'slot-12'))
  assert.notEqual(draftKey('acc-1', 'schouw', 'slot-12'), draftKey('acc-1', 'schouw', 'slot-13'))
})
