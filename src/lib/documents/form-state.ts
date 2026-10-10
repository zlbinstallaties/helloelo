import { allFields } from './forms.ts'
import type { DocumentType, FieldDef, FormDef, PhotosField, YesNo, YesNoField } from './forms.ts'
import { FORM_ERROR, LIMITS, validateSubmission } from './submission.ts'

/*
 * What the phone holds while a document is being filled in: the draft, and the steps that change it. No React and no
 * browser, so it is unit-tested in test/. Every change returns a new draft (the screen re-renders from it), and the
 * draft is what is kept in the browser, photos and signature included, so that a tab the phone removed from memory
 * while the camera was open does not take the work with it.
 *
 * The checks are those of the server (`validateSubmission`): the phone points at what is wrong, the server decides.
 */

export type DraftAnswer = string | string[] | { value: YesNo | ''; note: string }

export type Draft = {
  version: 1
  /** Made once per document and kept with the draft: sending the same draft twice is recognised by it. */
  submissionId: string
  /** When the draft was last changed (ISO). */
  savedAt: string
  /** The answers as typed; a field that was not touched is absent. */
  answers: Record<string, DraftAnswer>
  signature: { name: string; image: string }
}

export const DRAFT_VERSION = 1
/** A draft that nobody touched for a week is not brought back. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60_000

const SUBMISSION_ID = /^[A-Za-z0-9-]{16,64}$/
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/
const YES_NO: readonly string[] = ['ja', 'nee', 'nvt']

export function newSubmissionId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return random
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function emptyDraft(submissionId: string, now: Date): Draft {
  return { version: DRAFT_VERSION, submissionId, savedAt: now.toISOString(), answers: {}, signature: { name: '', image: '' } }
}

/** A draft belongs to one person, one kind of document and one appointment. */
export const draftKey = (userId: string, type: DocumentType, appointmentId: string) => `${userId}|${type}|${appointmentId}`

function withAnswer(draft: Draft, id: string, answer: DraftAnswer): Draft {
  return { ...draft, answers: { ...draft.answers, [id]: answer } }
}

export const setText = (draft: Draft, id: string, value: string): Draft => withAnswer(draft, id, value)

/** A note is only kept for the answer it explains, so changing the answer cannot leave a stale note behind. */
export function setYesNo(draft: Draft, field: YesNoField, value: YesNo): Draft {
  const current = draft.answers[field.id]
  const note = typeof current === 'object' && !Array.isArray(current) && current.value === value && field.explainWhen === value ? current.note : ''
  return withAnswer(draft, field.id, { value, note })
}

export function setNote(draft: Draft, id: string, note: string): Draft {
  const current = draft.answers[id]
  return withAnswer(draft, id, { value: typeof current === 'object' && !Array.isArray(current) ? current.value : '', note })
}

const photosOf = (draft: Draft, id: string): string[] => {
  const value = draft.answers[id]
  return Array.isArray(value) ? value : []
}

const totalPhotos = (form: FormDef, draft: Draft) =>
  allFields(form).reduce((sum, field) => (field.kind === 'photos' ? sum + photosOf(draft, field.id).length : sum), 0)

export function canAddPhoto(form: FormDef, draft: Draft, field: PhotosField): boolean {
  return photosOf(draft, field.id).length < field.max && totalPhotos(form, draft) < LIMITS.photosTotal
}

export function addPhoto(form: FormDef, draft: Draft, field: PhotosField, photo: string): Draft {
  if (!JPEG_DATA_URL.test(photo) || !canAddPhoto(form, draft, field)) return draft
  return withAnswer(draft, field.id, [...photosOf(draft, field.id), photo])
}

export function removePhoto(draft: Draft, id: string, index: number): Draft {
  const photos = photosOf(draft, id)
  if (!Number.isInteger(index) || index < 0 || index >= photos.length) return draft
  return withAnswer(draft, id, photos.filter((_photo, place) => place !== index))
}

export const setSignatureName = (draft: Draft, name: string): Draft => ({ ...draft, signature: { ...draft.signature, name } })
export const setSignatureImage = (draft: Draft, image: string): Draft => ({ ...draft, signature: { ...draft.signature, image } })

/** What the server gets: only fields of this form that were answered. Who fills it in is not sent: the session says. */
export function toPayload(form: FormDef, draft: Draft, appointmentId: string) {
  const answers: Record<string, unknown> = {}
  for (const field of allFields(form)) {
    const value = draft.answers[field.id]
    if (typeof value === 'string') {
      if (value.trim()) answers[field.id] = value.trim()
    } else if (Array.isArray(value)) {
      if (value.length > 0) answers[field.id] = value
    } else if (value && value.value) {
      answers[field.id] = { value: value.value, note: value.note.trim() }
    }
  }
  return { type: form.type, appointmentId, submissionId: draft.submissionId, answers, signature: { name: draft.signature.name.trim(), image: draft.signature.image } }
}

/** The errors per field id (empty when the document is complete), by the rules of the server. */
export function validateDraft(form: FormDef, draft: Draft, author: string): Record<string, string> {
  const { answers, signature } = toPayload(form, draft, '')
  const result = validateSubmission(form, { author, answers, signature })
  return result.ok ? {} : result.errors
}

/** The id of the first wrong field in the order of the screen, so the phone can jump to it. */
export function firstErrorId(form: FormDef, errors: Record<string, string>): string | null {
  const order = ['author', ...allFields(form).map((field) => field.id), FORM_ERROR, 'signature.name', 'signature.image']
  return order.find((id) => id in errors) ?? Object.keys(errors)[0] ?? null
}

function parseAnswer(field: FieldDef, raw: unknown): DraftAnswer | undefined {
  switch (field.kind) {
    case 'text':
    case 'textarea':
    case 'number':
    case 'date':
    case 'choice':
      return typeof raw === 'string' ? raw : undefined
    case 'yesno': {
      const value = raw as { value?: unknown; note?: unknown } | null
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.note !== 'string') return undefined
      if (value.value !== '' && !(typeof value.value === 'string' && YES_NO.includes(value.value))) return undefined
      return { value: value.value as YesNo | '', note: value.note }
    }
    case 'photos': {
      if (!Array.isArray(raw)) return undefined
      const photos = raw.filter((item): item is string => typeof item === 'string' && item.length <= LIMITS.photoChars && JPEG_DATA_URL.test(item))
      return photos.slice(0, field.max)
    }
  }
}

/** A draft as it was stored, or null when it is not one of this version, is too old or is damaged. Never throws. */
export function parseDraft(raw: unknown, form: FormDef, now: Date): Draft | null {
  const stored = raw as Record<string, unknown> | null
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.version !== DRAFT_VERSION) return null
  if (typeof stored.submissionId !== 'string' || !SUBMISSION_ID.test(stored.submissionId)) return null
  const savedAt = typeof stored.savedAt === 'string' ? Date.parse(stored.savedAt) : Number.NaN
  if (!Number.isFinite(savedAt) || now.getTime() - savedAt > DRAFT_MAX_AGE_MS) return null
  const signature = stored.signature as Record<string, unknown> | null
  if (!signature || typeof signature !== 'object' || typeof signature.name !== 'string' || typeof signature.image !== 'string') return null
  if (signature.image !== '' && (signature.image.length > LIMITS.signatureChars || !JPEG_DATA_URL.test(signature.image))) return null
  const rawAnswers = stored.answers as Record<string, unknown> | null
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) return null

  const answers: Record<string, DraftAnswer> = {}
  for (const field of allFields(form)) {
    const answer = parseAnswer(field, rawAnswers[field.id])
    if (answer !== undefined) answers[field.id] = answer
  }
  return { version: DRAFT_VERSION, submissionId: stored.submissionId, savedAt: new Date(savedAt).toISOString(), answers, signature: { name: signature.name, image: signature.image } }
}
