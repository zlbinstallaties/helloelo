import assert from 'node:assert/strict'
import test from 'node:test'
import { FORMS } from '../src/lib/documents/forms.ts'
import { DRAFT_MAX_AGE_MS, emptyDraft, setSignatureImage, setText } from '../src/lib/documents/form-state.ts'
import { deleteDraft, loadDraft, memoryDraftStorage, purgeOldDrafts, saveDraft } from '../src/lib/documents/draft-store.ts'
import type { DraftStorage } from '../src/lib/documents/draft-store.ts'
import { fitWithin, photoAttempts, PHOTO_MAX_SIDE } from '../src/lib/documents/photo.ts'
import { SIGNATURE } from './documents-fixtures.ts'

const NOW = new Date('2026-10-08T09:30:00Z')
const KEY = 'acc-1|schouw|slot-12'
const draft = () => setSignatureImage(setText(emptyDraft('f3b1c2d4-5e6f-4a7b-8c9d-0123456789ab', NOW), 'werkzaamheden', 'sanitair'), SIGNATURE)

test('a saved draft comes back as it was, photos and signature included, and is gone after delete', async () => {
  const storage = memoryDraftStorage()
  assert.equal(await saveDraft(storage, KEY, draft(), NOW), true)
  const back = await loadDraft(storage, KEY, FORMS.schouw, NOW)
  assert.equal(back?.answers.werkzaamheden, 'sanitair')
  assert.equal(back?.signature.image, SIGNATURE)
  assert.equal(back?.submissionId, 'f3b1c2d4-5e6f-4a7b-8c9d-0123456789ab')
  await deleteDraft(storage, KEY)
  assert.equal(await loadDraft(storage, KEY, FORMS.schouw, NOW), null)
})

test('the time of saving is the time of the last change, so a draft in use does not run out', async () => {
  const storage = memoryDraftStorage()
  await saveDraft(storage, KEY, draft(), new Date(NOW.getTime() - DRAFT_MAX_AGE_MS + 1000))
  const later = new Date(NOW.getTime() + 5 * 60_000)
  await saveDraft(storage, KEY, draft(), later)
  assert.equal((await loadDraft(storage, KEY, FORMS.schouw, new Date(later.getTime() + DRAFT_MAX_AGE_MS - 1000)))?.savedAt, later.toISOString())
})

test('a draft that is damaged or too old is removed when it is read, and the phone starts fresh', async () => {
  const storage = memoryDraftStorage()
  storage.data.set(KEY, { key: KEY, savedAt: NOW.toISOString(), draft: { version: 7 } })
  assert.equal(await loadDraft(storage, KEY, FORMS.schouw, NOW), null)
  assert.equal(storage.data.has(KEY), false)
  await saveDraft(storage, KEY, draft(), new Date(NOW.getTime() - DRAFT_MAX_AGE_MS - 60_000))
  assert.equal(await loadDraft(storage, KEY, FORMS.schouw, NOW), null)
  assert.equal(storage.data.has(KEY), false)
})

test('storage that fails (full, private window) never breaks the form: saving says no, loading says nothing', async () => {
  const broken: DraftStorage = {
    get: async () => { throw new Error('boom') }, put: async () => { throw new Error('quota') }, remove: async () => { throw new Error('boom') }, purgeBefore: async () => { throw new Error('boom') },
  }
  assert.equal(await saveDraft(broken, KEY, draft(), NOW), false)
  assert.equal(await loadDraft(broken, KEY, FORMS.schouw, NOW), null)
  await deleteDraft(broken, KEY)
  await purgeOldDrafts(broken, NOW)
  assert.equal(await saveDraft(null, KEY, draft(), NOW), false, 'no storage at all')
  assert.equal(await loadDraft(null, KEY, FORMS.schouw, NOW), null)
})

test('old drafts of appointments nobody opened again are purged; recent ones stay', async () => {
  const storage = memoryDraftStorage()
  await saveDraft(storage, 'old', draft(), new Date(NOW.getTime() - DRAFT_MAX_AGE_MS - 1000))
  await saveDraft(storage, 'recent', draft(), new Date(NOW.getTime() - 1000))
  await purgeOldDrafts(storage, NOW)
  assert.deepEqual([...storage.data.keys()], ['recent'])
})

test('a photo is scaled down to at most 1600 px on the long side and never up', () => {
  assert.deepEqual(fitWithin(4000, 3000), { width: PHOTO_MAX_SIDE, height: 1200 })
  assert.deepEqual(fitWithin(3000, 4000), { width: 1200, height: PHOTO_MAX_SIDE })
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 })
  assert.deepEqual(fitWithin(1, 5000), { width: 1, height: PHOTO_MAX_SIDE })
  assert.deepEqual(fitWithin(5000, 1), { width: PHOTO_MAX_SIDE, height: 1 })
})

test('the tries to get a photo small enough: first as good as allowed, then smaller; every try is a real size', () => {
  const tries = photoAttempts(4000, 3000)
  assert.deepEqual(tries[0], { width: 1600, height: 1200, quality: 0.8 })
  assert.ok(tries.length >= 4)
  for (let index = 1; index < tries.length; index++) {
    assert.ok(tries[index].quality <= tries[index - 1].quality, 'quality never goes up')
    assert.ok(tries[index].width <= tries[index - 1].width && tries[index].height <= tries[index - 1].height, 'size never goes up')
  }
  for (const attempt of photoAttempts(1, 5000)) {
    assert.ok(attempt.width >= 1 && attempt.height >= 1 && Number.isInteger(attempt.width) && Number.isInteger(attempt.height))
  }
  assert.deepEqual(photoAttempts(800, 600)[0], { width: 800, height: 600, quality: 0.8 }, 'a small photo is not scaled up')
})
