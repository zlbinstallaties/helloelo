import { allFields } from './forms.ts'
import type { FieldDef, FormDef, YesNo } from './forms.ts'

/*
 * Checks what a phone sends against the form definition. Pure, and used twice: in the browser to point at the
 * field that is wrong, and on the server, which never trusts the browser. Whatever the server keeps is the CLEAN
 * result: only fields of the form, trimmed, with the right shape.
 */

export type CleanAnswer = string | string[] | { value: YesNo; note: string }

export type CleanSubmission = {
  /** Who filled it in (until accounts supply this). */
  author: string
  /** Only the fields that were answered. */
  answers: Record<string, CleanAnswer>
  signature: { name: string; image: string }
}

export type ValidationResult =
  | { ok: true; value: CleanSubmission }
  | { ok: false; errors: Record<string, string> }

export const LIMITS = {
  text: 200,
  textarea: 4000,
  note: 1000,
  name: 80,
  /** Length of a photo as a base64 data URL; the browser shrinks photos far below this. */
  photoChars: 700_000,
  photosTotal: 12,
  signatureChars: 300_000,
} as const

/** Error key for a problem that belongs to no single field. */
export const FORM_ERROR = '_form'

const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/
const NUMBER = /^-?\d{1,9}([.,]\d{1,3})?$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
}

function isRealDate(value: string) {
  const match = DATE.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const REQUIRED = 'Dit veld is verplicht.'

function checkField(field: FieldDef, raw: unknown): { answer?: CleanAnswer; error?: string } {
  switch (field.kind) {
    case 'text':
    case 'textarea': {
      const max = field.kind === 'text' ? LIMITS.text : LIMITS.textarea
      const text = clean(raw)
      if (!text) return field.required ? { error: REQUIRED } : {}
      if (text.length > max) return { error: `Maximaal ${max} tekens.` }
      return { answer: text }
    }
    case 'number': {
      const text = clean(raw)
      if (!text) return field.required ? { error: REQUIRED } : {}
      if (!NUMBER.test(text)) return { error: 'Vul een getal in.' }
      return { answer: text }
    }
    case 'date': {
      const text = clean(raw)
      if (!text) return field.required ? { error: REQUIRED } : {}
      if (!isRealDate(text)) return { error: 'Vul een geldige datum in.' }
      return { answer: text }
    }
    case 'choice': {
      const text = clean(raw)
      if (!text) return field.required ? { error: REQUIRED } : {}
      if (!field.options.some((option) => option.value === text)) return { error: 'Kies een van de opties.' }
      return { answer: text }
    }
    case 'yesno': {
      if (raw === undefined || raw === null || (isRecord(raw) && !raw.value)) {
        return field.required ? { error: 'Kies ja of nee.' } : {}
      }
      if (!isRecord(raw)) return { error: 'Kies ja of nee.' }
      const value = raw.value
      const allowed: YesNo[] = field.allowNa ? ['ja', 'nee', 'nvt'] : ['ja', 'nee']
      if (typeof value !== 'string' || !(allowed as string[]).includes(value)) return { error: 'Kies een van de opties.' }
      const note = clean(raw.note)
      if (note.length > LIMITS.note) return { error: `Maximaal ${LIMITS.note} tekens.` }
      if (field.explainWhen === value && !note) return { error: 'Geef een toelichting.' }
      // A note is only kept for the answer it explains, so a changed answer cannot leave a stale note behind.
      return { answer: { value: value as YesNo, note: field.explainWhen === value ? note : '' } }
    }
    case 'photos': {
      const photos = raw === undefined || raw === null ? [] : raw
      if (!Array.isArray(photos)) return { error: "Ongeldige foto's." }
      if (photos.length === 0) return field.required ? { error: "Voeg minstens één foto toe." } : {}
      if (photos.length > field.max) return { error: `Maximaal ${field.max} foto's.` }
      for (const photo of photos) {
        if (typeof photo !== 'string' || photo.length > LIMITS.photoChars || !JPEG_DATA_URL.test(photo)) {
          return { error: 'Een foto is ongeldig of te groot. Maak hem opnieuw.' }
        }
      }
      return { answer: photos as string[] }
    }
  }
}

export function validateSubmission(form: FormDef, input: unknown): ValidationResult {
  const errors: Record<string, string> = {}
  const body = isRecord(input) ? input : {}
  const rawAnswers = isRecord(body.answers) ? body.answers : {}
  const answers: Record<string, CleanAnswer> = {}

  // Unknown ids in the input are dropped: only fields of this form are kept.
  for (const field of allFields(form)) {
    const result = checkField(field, rawAnswers[field.id])
    if (result.error) errors[field.id] = result.error
    else if (result.answer !== undefined) answers[field.id] = result.answer
  }

  const photoCount = Object.values(answers).reduce((sum, answer) => (Array.isArray(answer) ? sum + answer.length : sum), 0)
  if (photoCount > LIMITS.photosTotal) errors[FORM_ERROR] = `Maximaal ${LIMITS.photosTotal} foto's in totaal.`

  const author = clean(body.author)
  if (author.length < 2) errors.author = 'Vul de naam van de monteur in.'
  else if (author.length > LIMITS.name) errors.author = `Maximaal ${LIMITS.name} tekens.`

  const rawSignature = isRecord(body.signature) ? body.signature : {}
  const signatureName = clean(rawSignature.name)
  if (signatureName.length < 2) errors['signature.name'] = 'Vul de naam van de klant in.'
  else if (signatureName.length > LIMITS.name) errors['signature.name'] = `Maximaal ${LIMITS.name} tekens.`
  const image = rawSignature.image
  if (typeof image !== 'string' || !image) errors['signature.image'] = 'De klant moet nog tekenen.'
  else if (image.length > LIMITS.signatureChars || !JPEG_DATA_URL.test(image)) errors['signature.image'] = 'De handtekening is ongeldig. Teken opnieuw.'

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: { author, answers, signature: { name: signatureName, image: image as string } },
  }
}
