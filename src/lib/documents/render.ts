import { YES_NO_LABELS } from './forms.ts'
import type { FieldDef, FormDef } from './forms.ts'
import { dataUrlToBytes, parseJpeg } from './jpeg.ts'
import { PAGE_HEIGHT, PAGE_WIDTH, PdfBuilder } from './pdf.ts'
import type { Font, PdfImage } from './pdf.ts'
import type { CleanAnswer, CleanSubmission } from './submission.ts'

/*
 * Turns a filled-in form into the PDF that is stored on the customer. Pure: it gets everything it needs as
 * arguments (including the time), so the same input always gives the same file.
 */

export class DocumentRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentRenderError'
  }
}

export type RenderContext = {
  companyName: string
  customer: string
  address: string
  appointmentTitle: string
  /** YYYY-MM-DD, the day of the appointment. */
  appointmentDate: string
  /** The technicians planned on the appointment. */
  people: string[]
  createdAt: Date
}

const MARGIN = 42
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN
const TOP = PAGE_HEIGHT - 48
const BOTTOM = 62
const LABEL_COLUMN = 112
/** Width reserved for the word "Toelichting:" in front of an explanation. */
const NOTE_LABEL = 62

/** The brand of De Installatiegroep (Claude Design: "Logo De Installatiegroep" and the design system audit). */
const BRAND = {
  /** Navy: text and titles. */
  ink: '#16283C',
  /** Secondary text; about 5:1 on white. */
  muted: '#4E6B87',
  /** The seam of the mark and the full stop of the wordmark. Decoration only: copper is too light for small text. */
  copper: '#B87333',
  /** The copper that may carry small text. */
  copperText: '#9F6229',
  paper: '#F7F5F1',
  hairline: '#DCDCDB',
} as const

const dateFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })
const dateTimeFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'long', timeStyle: 'short' })
const stampFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' })

function formatDate(isoDate: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? dateFormat.format(new Date(`${isoDate}T12:00:00Z`)) : isoDate
}

function slug(value: string): string {
  const text = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return text || 'klant'
}

/** e.g. `schouw-familie-van-den-berg-20261008.pdf`; letters, digits and dashes only. */
export function documentFilename(form: FormDef, customer: string, createdAt: Date): string {
  return `${form.filePrefix}-${slug(customer)}-${stampFormat.format(createdAt).replaceAll('-', '')}.pdf`
}

/** One line for the note that is logged with the file. */
export function documentSummary(form: FormDef, customer: string, createdAt: Date): string {
  return `${form.title} – ${customer} – ${dateTimeFormat.format(createdAt)}`
}

function toImage(url: string, what: string): PdfImage {
  const data = dataUrlToBytes(url)
  const info = data ? parseJpeg(data) : null
  if (!data || !info) throw new DocumentRenderError(`${what} is geen geldige JPEG.`)
  return { ...info, data }
}

type PhotoItem = { image: PdfImage; width: number; height: number }

const PHOTO_GAP = 8
const PHOTO_MAX_HEIGHT = 140
const PHOTO_CELL = (CONTENT_WIDTH - 2 * PHOTO_GAP) / 3

/** Decodes the photos and places them three per row. Throws for a photo that is not a usable JPEG. */
function layoutPhotos(photos: string[], label: string): Array<{ items: PhotoItem[]; height: number }> {
  const rows: Array<{ items: PhotoItem[]; height: number }> = []
  for (let start = 0; start < photos.length; start += 3) {
    const items: PhotoItem[] = photos.slice(start, start + 3).map((url, i) => {
      const image = toImage(url, `Foto ${start + i + 1} bij "${label}"`)
      const scale = Math.min(PHOTO_CELL / image.width, PHOTO_MAX_HEIGHT / image.height)
      return { image, width: image.width * scale, height: image.height * scale }
    })
    rows.push({ items, height: Math.max(...items.map((item) => item.height)) })
  }
  return rows
}

function valueText(field: FieldDef, answer: CleanAnswer | undefined): { text: string; note?: string } {
  if (answer === undefined) return { text: '' }
  switch (field.kind) {
    case 'yesno': {
      const { value, note } = answer as { value: keyof typeof YES_NO_LABELS; note: string }
      return { text: YES_NO_LABELS[value], note: note || undefined }
    }
    case 'choice':
      return { text: field.options.find((option) => option.value === answer)?.label ?? String(answer) }
    case 'number':
      return { text: `${String(answer).replace('.', ',')}${field.unit ? ` ${field.unit}` : ''}` }
    case 'date':
      return { text: formatDate(String(answer)) }
    default:
      return { text: String(answer) }
  }
}

export function renderDocumentPdf(form: FormDef, context: RenderContext, submission: CleanSubmission): Uint8Array {
  const pdf = new PdfBuilder({
    title: `${form.title} – ${context.customer}`,
    author: submission.author,
    created: context.createdAt,
  })
  pdf.newPage()
  let y = TOP

  function ensure(height: number) {
    if (y - height >= BOTTOM) return
    pdf.newPage()
    y = TOP
  }

  /** Draws lines one by one, so a long text carries on over the page break. */
  function lines(list: string[], x: number, size: number, lineHeight: number, options: { font?: Font; color?: string } = {}) {
    for (const line of list) {
      ensure(lineHeight)
      pdf.text(x, y - size, line, { size, font: options.font, color: options.color ?? BRAND.ink })
      y -= lineHeight
    }
  }

  /** A section title in the serif of the brand, with the copper seam on the rule below it. */
  function heading(title: string) {
    pdf.text(MARGIN, y - 14, title, { size: 14, font: 'serif-bold', color: BRAND.ink })
    pdf.line(MARGIN, y - 22, PAGE_WIDTH - MARGIN, y - 22, { width: 0.75, color: BRAND.hairline })
    pdf.rect(MARGIN, y - 23, 28, 2, { fill: BRAND.copper })
    y -= 36
  }

  // Photos are decoded up front: a broken one fails before anything is laid out, and the layout knows how tall
  // the first row is, so a label never ends up alone at the bottom of a page.
  const photoRows = new Map<string, ReturnType<typeof layoutPhotos>>()
  for (const field of form.sections.flatMap((section) => section.fields)) {
    const answer = submission.answers[field.id]
    if (field.kind === 'photos' && Array.isArray(answer) && answer.length > 0) photoRows.set(field.id, layoutPhotos(answer, field.label))
  }

  /** The least room a field needs: its label together with the first line (or first row of photos) of its answer. */
  function minHeight(field: FieldDef): number {
    const label = pdf.wrap(field.label, CONTENT_WIDTH, 9, 'sans-bold').length * 12
    if (field.kind !== 'photos') return label + 14
    return label + 2 + (photoRows.get(field.id)?.[0]?.height ?? 14) + PHOTO_GAP
  }

  // Letterhead: the mark (navy square with the copper seam), the wordmark and the environment on the right.
  const mark = 26
  pdf.rect(MARGIN, y - mark, mark, mark, { fill: BRAND.ink })
  pdf.rect(MARGIN + (mark * 40) / 64, y - mark, (mark * 4) / 64, mark, { fill: BRAND.copper })
  const wordmarkX = MARGIN + mark + 10
  const wordmarkSize = 16
  pdf.text(wordmarkX, y - mark + 8, 'De Installatiegroep', { size: wordmarkSize, font: 'serif-bold', color: BRAND.ink })
  pdf.text(wordmarkX + pdf.textWidth('De Installatiegroep', wordmarkSize, 'serif-bold'), y - mark + 8, '.', {
    size: wordmarkSize,
    font: 'serif-bold',
    color: BRAND.copper,
  })
  const environment = pdf.textWidth(context.companyName, 8.5)
  pdf.text(PAGE_WIDTH - MARGIN - environment, y - mark + 9, context.companyName, { size: 8.5, color: BRAND.muted })
  y -= mark + 14
  pdf.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, { width: 0.75, color: BRAND.hairline })
  y -= 30

  // Title with the short copper rule of the wordmark.
  pdf.text(MARGIN, y - 22, form.title, { size: 24, font: 'serif-bold', color: BRAND.ink })
  pdf.rect(MARGIN, y - 36, 56, 2.5, { fill: BRAND.copper })
  y -= 56

  // The facts of the appointment, in a panel.
  const facts: Array<[string, string]> = [
    ['Klant', context.customer],
    ['Adres', context.address],
    ['Afspraak', context.appointmentTitle],
    ['Datum afspraak', formatDate(context.appointmentDate)],
    ['Monteur(s)', context.people.join(', ')],
    ['Ingevuld door', submission.author],
    ['Opgesteld op', dateTimeFormat.format(context.createdAt)],
  ]
  const factLines = facts.map(([, value]) => pdf.wrap(value || '—', CONTENT_WIDTH - LABEL_COLUMN - 12, 10))
  const panelHeight = factLines.reduce((sum, list) => sum + list.length * 13 + 4, 0) + 20
  ensure(panelHeight)
  pdf.rect(MARGIN, y - panelHeight, CONTENT_WIDTH, panelHeight, { fill: BRAND.paper, stroke: BRAND.hairline, lineWidth: 0.75 })
  let rowY = y - 14
  facts.forEach(([label], index) => {
    pdf.text(MARGIN + 12, rowY - 10, label, { size: 8.5, font: 'sans-bold', color: BRAND.muted })
    for (const line of factLines[index]) {
      pdf.text(MARGIN + 12 + LABEL_COLUMN, rowY - 10, line, { size: 10, color: BRAND.ink })
      rowY -= 13
    }
    rowY -= 4
  })
  y -= panelHeight + 16

  // The sections of the form.
  for (const section of form.sections) {
    ensure(36 + (section.fields[0] ? minHeight(section.fields[0]) : 0))
    y -= 6
    heading(section.title)

    for (const field of section.fields) {
      const answer = submission.answers[field.id]
      const labelLines = pdf.wrap(field.label, CONTENT_WIDTH, 9, 'sans-bold')

      if (field.kind === 'photos') {
        ensure(minHeight(field))
        lines(labelLines, MARGIN, 9, 12, { font: 'sans-bold', color: BRAND.muted })
        y -= 2
        const rows = photoRows.get(field.id) ?? []
        if (rows.length === 0) lines(['Geen foto’s toegevoegd.'], MARGIN, 10, 14, { color: BRAND.muted })
        for (const row of rows) {
          ensure(row.height + PHOTO_GAP)
          row.items.forEach((item, i) => {
            const x = MARGIN + i * (PHOTO_CELL + PHOTO_GAP)
            pdf.image(item.image, x, y - item.height, item.width, item.height)
            pdf.rect(x, y - item.height, item.width, item.height, { stroke: BRAND.hairline, lineWidth: 0.5 })
          })
          y -= row.height + PHOTO_GAP
        }
        y -= 8
        continue
      }

      const { text, note } = valueText(field, answer)
      const valueFont: Font = field.kind === 'yesno' ? 'sans-bold' : 'sans'
      const valueLines = text ? pdf.wrap(text, CONTENT_WIDTH - 10, 10, valueFont) : []
      // Keep the label together with the first line of the answer.
      ensure(labelLines.length * 12 + 14)
      lines(labelLines, MARGIN, 9, 12, { font: 'sans-bold', color: BRAND.muted })
      if (valueLines.length === 0) lines(['Niet ingevuld'], MARGIN + 10, 10, 14, { color: BRAND.muted })
      else lines(valueLines, MARGIN + 10, 10, 14, { font: valueFont })
      if (note) {
        const noteLines = pdf.wrap(note, CONTENT_WIDTH - 10 - NOTE_LABEL, 10)
        noteLines.forEach((line, i) => {
          ensure(14)
          if (i === 0) pdf.text(MARGIN + 10, y - 10, 'Toelichting:', { size: 10, font: 'sans-bold', color: BRAND.copperText })
          pdf.text(MARGIN + 10 + NOTE_LABEL, y - 10, line, { size: 10, color: BRAND.ink })
          y -= 14
        })
      }
      y -= 8
    }
  }

  // Signature of the customer.
  ensure(210)
  y -= 6
  heading('Ondertekening')
  lines(pdf.wrap(form.signatureStatement, CONTENT_WIDTH, 10), MARGIN, 10, 14)
  y -= 8
  const boxWidth = 250
  const boxHeight = 95
  const signature = toImage(submission.signature.image, 'De handtekening')
  const fit = Math.min((boxWidth - 8) / signature.width, (boxHeight - 8) / signature.height)
  const drawnWidth = signature.width * fit
  const drawnHeight = signature.height * fit
  pdf.image(signature, MARGIN + (boxWidth - drawnWidth) / 2, y - boxHeight + (boxHeight - drawnHeight) / 2, drawnWidth, drawnHeight)
  pdf.rect(MARGIN, y - boxHeight, boxWidth, boxHeight, { stroke: BRAND.hairline, lineWidth: 0.75 })
  y -= boxHeight + 10
  lines([`Naam: ${submission.signature.name}`], MARGIN, 10, 14, { font: 'sans-bold' })
  lines([`Getekend op: ${dateTimeFormat.format(context.createdAt)}`], MARGIN, 10, 14, { color: BRAND.muted })

  // Footer with page numbers, now that the number of pages is known.
  const total = pdf.pageCount
  const footer = `De Installatiegroep · ${form.title} · ${context.customer}`
  for (let page = 0; page < total; page++) {
    pdf.usePage(page)
    pdf.line(MARGIN, 44, PAGE_WIDTH - MARGIN, 44, { width: 0.75, color: BRAND.hairline })
    const pageLabel = `Pagina ${page + 1} van ${total}`
    const pageWidth = pdf.textWidth(pageLabel, 8)
    let shown = footer
    while (shown.length > 1 && pdf.textWidth(shown, 8) > CONTENT_WIDTH - pageWidth - 16) shown = `${shown.slice(0, -2)}…`
    pdf.text(MARGIN, 30, shown, { size: 8, color: BRAND.muted })
    pdf.text(PAGE_WIDTH - MARGIN - pageWidth, 30, pageLabel, { size: 8, color: BRAND.muted })
  }

  return pdf.build()
}
