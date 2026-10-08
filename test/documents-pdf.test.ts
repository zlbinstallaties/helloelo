import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FORMS } from '../src/lib/documents/forms.ts'
import { dataUrlToBytes, parseJpeg } from '../src/lib/documents/jpeg.ts'
import { PdfBuilder } from '../src/lib/documents/pdf.ts'
import { DocumentRenderError, documentFilename, documentSummary, renderDocumentPdf } from '../src/lib/documents/render.ts'
import type { RenderContext } from '../src/lib/documents/render.ts'
import { validateSubmission } from '../src/lib/documents/submission.ts'
import type { CleanSubmission } from '../src/lib/documents/submission.ts'
import { PHOTO, SIGNATURE } from './documents-fixtures.ts'

const createdAt = new Date('2026-10-08T18:30:00Z') // 20:30 in Amsterdam

const context: RenderContext = {
  companyName: 'De Installatiegroep B.V. [TEST]',
  customer: 'Familie Van den Béérg (Müller)',
  address: 'Molenweg 4, 3990 AB Houten',
  appointmentTitle: 'Schouw badkamer',
  appointmentDate: '2026-10-09',
  people: ['Jan de Vries', 'Piet Bakker'],
  createdAt,
}

function latin1(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('latin1')
}

function submission(form: typeof FORMS.schouw, answers: Record<string, unknown>): CleanSubmission {
  const result = validateSubmission(form, {
    author: 'Jan de Vries',
    answers,
    signature: { name: 'Mevr. Van den Berg', image: SIGNATURE },
  })
  assert.ok(result.ok, JSON.stringify(result.ok ? {} : result.errors))
  return result.value
}

const schouwAnswers = {
  parkeren: { value: 'nee', note: 'Alleen betaald parkeren, 2 straten verderop.' },
  huisdieren: { value: 'nee' },
  werkzaamheden: 'sanitair',
  bouwjaar: '1975',
  meterkast: { value: 'nvt' },
  asbest: { value: 'ja', note: 'Golfplaten achter de schuur (€ 0 meerwerk).' },
  ruimte: 'Badkamer 2,4 x 1,8 m.\nPlafond 2,3 m (kostprijs “laag”).',
  fotos_situatie: [PHOTO, PHOTO, PHOTO, PHOTO],
}

/** Every object must sit at the byte offset the xref table claims, and the page tree must add up. */
function assertWellFormed(pdf: Uint8Array) {
  const text = latin1(pdf)
  assert.ok(text.startsWith('%PDF-1.4\n'))
  assert.ok(text.endsWith('%%EOF\n'))
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1])
  assert.equal(text.slice(start, start + 4), 'xref')
  const header = /xref\n0 (\d+)\n/.exec(text.slice(start))
  const count = Number(header?.[1])
  const entries = text.slice(start + (header?.[0].length ?? 0)).split('\n').slice(0, count)
  assert.equal(entries[0], '0000000000 65535 f ')
  for (let id = 1; id < count; id++) {
    assert.match(entries[id], /^\d{10} 00000 n $/, `entry ${id} is 20 bytes with its newline`)
    const offset = Number(entries[id].slice(0, 10))
    assert.ok(text.startsWith(`${id} 0 obj\n`, offset), `object ${id} is at ${offset}`)
  }
  const pages = (text.match(/\/Type \/Page \//g) ?? []).length
  assert.equal(Number(/\/Count (\d+)/.exec(text)?.[1]), pages)
  return { text, pages }
}

function pdfToText(pdf: Uint8Array): string | null {
  const probe = spawnSync('pdftotext', ['-v'])
  if (probe.error) return null
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-test-'))
  const file = path.join(dir, 'out.pdf')
  writeFileSync(file, pdf)
  const run = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
}

test('builder: a valid file with an empty page, escapes and metadata', () => {
  const pdf = new PdfBuilder({ title: 'Test (met) \\ tekens', created: createdAt })
  pdf.text(40, 700, 'Haakjes (en) een \\ en é ë ü ’ € •', { size: 10 })
  const { text, pages } = assertWellFormed(pdf.build())
  assert.equal(pages, 1, 'a document without pages still gets one')
  assert.ok(text.includes('/CreationDate (D:20261008183000Z)'))
  assert.ok(text.includes('(Haakjes \\(en\\) een \\\\ en \\351 \\353 \\374 \\222 \\200 \\225)'), 'WinAnsi octal escapes')
  assert.ok(text.includes('/Title (Test \\(met\\) \\\\ tekens)'))
  const body = text.slice(text.indexOf('1 0 obj'))
  let firstNonAscii = -1
  for (let i = 0; i < body.length && firstNonAscii < 0; i++) if (body.charCodeAt(i) > 127) firstNonAscii = i
  assert.equal(firstNonAscii, -1, 'everything after the header is plain ASCII')
})

test('builder: wrapping honours the width, paragraphs and very long words', () => {
  const pdf = new PdfBuilder({ title: 't', created: createdAt })
  const width = 120
  const lines = pdf.wrap('Dit is een lange zin die over meerdere regels moet lopen\n\nNieuwe alinea', width, 10)
  assert.ok(lines.length >= 5)
  assert.ok(lines.includes(''), 'the blank line between paragraphs is kept')
  for (const line of lines) assert.ok(pdf.textWidth(line, 10) <= width, line)
  const cut = pdf.wrap('Supercalifragilisticexpialidocious-en-nog-veel-langer', 80, 10)
  assert.ok(cut.length > 1)
  for (const line of cut) assert.ok(pdf.textWidth(line, 10) <= 80, line)
  assert.equal(cut.join(''), 'Supercalifragilisticexpialidocious-en-nog-veel-langer')
  // Helvetica "Hello" is 2278 units: 22.78 points at size 10; accents do not change the width.
  assert.ok(Math.abs(pdf.textWidth('Hello', 10) - 22.78) < 0.001)
  assert.equal(pdf.textWidth('é', 10), pdf.textWidth('e', 10))
  // The last entry of each table is '~': a table with a missing or extra value shifts every letter after it.
  for (const [font, tilde, capitalA, lowerZ] of [['sans', 584, 667, 500], ['sans-bold', 584, 722, 500], ['serif-bold', 520, 722, 444]] as const) {
    assert.equal(pdf.textWidth('~', 1000, font), tilde, `${font} ~`)
    assert.equal(pdf.textWidth('A', 1000, font), capitalA, `${font} A`)
    assert.equal(pdf.textWidth('z', 1000, font), lowerZ, `${font} z`)
  }
  assert.ok(pdf.textWidth('Hello', 10, 'sans-bold') > pdf.textWidth('Hello', 10))
  assert.ok(Math.abs(pdf.textWidth('Hello', 10, 'serif-bold') - 22.78) < 0.001)
})

test('a schouw renders to a well-formed PDF with the customer, answers, photos and signature', () => {
  const pdf = renderDocumentPdf(FORMS.schouw, context, submission(FORMS.schouw, schouwAnswers))
  const { text, pages } = assertWellFormed(pdf)
  assert.equal(pages, 2)
  assert.equal((text.match(/\/Subtype \/Image/g) ?? []).length, 5, 'four photos and the signature')
  assert.ok(text.includes('/Author (Jan de Vries)'))

  const plain = pdfToText(pdf)
  if (plain === null) return // pdftotext is not installed: the structure checks above still ran
  for (const expected of [
    'Schouwdocument',
    'Familie Van den Béérg (Müller)',
    'Molenweg 4, 3990 AB Houten',
    '9 oktober 2026',
    'Jan de Vries, Piet Bakker',
    'Sanitair of badkamer',
    '1975',
    'Niet van toepassing',
    'Alleen betaald parkeren',
    '€ 0 meerwerk',
    '“laag”',
    'Naam: Mevr. Van den Berg',
    'Getekend op: 8 oktober 2026 om 20:30',
    'Pagina 1 van 2',
    'Pagina 2 van 2',
  ]) {
    assert.ok(plain.includes(expected), `missing "${expected}" in:\n${plain}`)
  }
  assert.ok(plain.includes('Niet ingevuld'), 'an optional field without an answer says so')
  // The photo heading, its label and its first row stay together: they all move to page 2.
  const breakAt = plain.indexOf('Pagina 1 van 2')
  assert.ok(plain.indexOf("Foto's van de situatie") > breakAt, 'the photo label is not left alone at the bottom of page 1')
  const heading = plain.split('\n').findIndex((line) => line.trim() === "Foto's")
  assert.ok(heading >= 0 && plain.split('\n').slice(0, heading).join('\n').includes('Pagina 1 van 2'), 'the section heading moved with it')
})

test('a long document runs over several pages with correct page numbers', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Regel ${i + 1} van een lange opmerking van de klant.`).join('\n')
  const pdf = renderDocumentPdf(
    FORMS.oplevering,
    context,
    submission(FORMS.oplevering, {
      uitgevoerd: long,
      volledig: { value: 'ja' },
      getest: { value: 'ja' },
      instructie: { value: 'ja' },
      opgeruimd: { value: 'ja' },
      opmerkingen_klant: long,
      fotos_resultaat: Array(8).fill(PHOTO),
    }),
  )
  const { pages } = assertWellFormed(pdf)
  assert.ok(pages >= 3, `pages: ${pages}`)
  const plain = pdfToText(pdf)
  if (plain === null) return
  assert.ok(plain.includes(`Pagina 1 van ${pages}`) && plain.includes(`Pagina ${pages} van ${pages}`))
  assert.ok(plain.includes('Regel 60 van een lange opmerking'), 'nothing is lost at a page break')
  assert.ok(plain.includes('Opleverdocument') && plain.includes('Naam: Mevr. Van den Berg'))
})

test('a broken image makes rendering fail with a clear error instead of a broken PDF', () => {
  const broken = submission(FORMS.schouw, schouwAnswers)
  broken.answers.fotos_situatie = ['data:image/jpeg;base64,AAAAAAAAAAAA']
  assert.throws(() => renderDocumentPdf(FORMS.schouw, context, broken), (error) => {
    assert.ok(error instanceof DocumentRenderError)
    assert.match(error.message, /Foto 1/)
    return true
  })
  const noSignature = submission(FORMS.schouw, schouwAnswers)
  noSignature.signature.image = 'data:image/jpeg;base64,AAAAAAAAAAAA'
  assert.throws(() => renderDocumentPdf(FORMS.schouw, context, noSignature), /handtekening/)
})

test('rendering is deterministic', () => {
  const input = submission(FORMS.schouw, schouwAnswers)
  assert.deepEqual(renderDocumentPdf(FORMS.schouw, context, input), renderDocumentPdf(FORMS.schouw, context, input))
})

test('file name and summary', () => {
  assert.equal(documentFilename(FORMS.schouw, 'Familie Van den Béérg (Müller)', createdAt), 'schouw-familie-van-den-beerg-muller-20261008.pdf')
  assert.equal(documentFilename(FORMS.oplevering, '???', new Date('2026-12-31T23:30:00Z')), 'oplevering-klant-20270101.pdf', 'dated in Amsterdam')
  assert.match(documentFilename(FORMS.schouw, 'x'.repeat(200), createdAt), /^schouw-x{40}-20261008\.pdf$/)
  assert.equal(documentSummary(FORMS.oplevering, 'Jansen', createdAt), 'Opleverdocument – Jansen – 8 oktober 2026 om 20:30')
  const photo = dataUrlToBytes(PHOTO)
  assert.ok(photo && parseJpeg(photo))
})
