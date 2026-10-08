import type { JpegInfo } from './jpeg.ts'

/*
 * A small PDF writer with no dependencies: text in Helvetica and Times, lines, rectangles and JPEG images, on A4 pages.
 * Enough for a form with photos and a signature; it is not a general PDF library.
 *
 *  - Text is written in WinAnsi, so Dutch accents work. A character outside it becomes "?".
 *  - JPEG photos are embedded as they are (DCTDecode), so there is no image decoding.
 *  - Coordinates are in points from the bottom left, as in PDF itself.
 */

export const PAGE_WIDTH = 595.28
export const PAGE_HEIGHT = 841.89

// Advance widths of Helvetica and Helvetica-Bold for the characters 32 to 126, per 1000 units of the font size.
// prettier-ignore
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
// prettier-ignore
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]

// prettier-ignore
const TIMES_BOLD = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500,
  500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500,
  556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
]

/** The three faces the writer knows: Helvetica, Helvetica-Bold and Times-Bold (the serif of the brand's titles). */
export type Font = 'sans' | 'sans-bold' | 'serif-bold'

const WIDTHS: Readonly<Record<Font, readonly number[]>> = { sans: HELVETICA, 'sans-bold': HELVETICA_BOLD, 'serif-bold': TIMES_BOLD }
export const FONT_RESOURCE: Readonly<Record<Font, string>> = { sans: 'F1', 'sans-bold': 'F2', 'serif-bold': 'F3' }

// Code points that are in WinAnsi at a different place than their Unicode value.
const WIN_ANSI: Readonly<Record<number, number>> = {
  0x20ac: 0x80, // €
  0x2026: 0x85, // …
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x2122: 0x99, // ™
}

/** Width of one character in 1/1000 of the font size. */
function glyphWidth(char: string, font: Font): number {
  const table = WIDTHS[font]
  const code = char.charCodeAt(0)
  if (code >= 32 && code <= 126) return table[code - 32]
  // Accented letters are as wide as the letter under the accent.
  const base = char.normalize('NFD')[0]
  const baseCode = base.charCodeAt(0)
  if (base !== char && baseCode >= 32 && baseCode <= 126) return table[baseCode - 32]
  if (char === '—') return 1000
  if (char === '…') return 1000
  if (char === '•') return 350
  if (char === '‘' || char === '’') return 222
  if (char === '“' || char === '”') return 333
  return font === 'serif-bold' ? 500 : 556
}

/** The characters as WinAnsi bytes. Line breaks and tabs become spaces; other control characters are dropped. */
function toWinAnsi(text: string): number[] {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) as number
    if (code === 9 || code === 10 || code === 13) bytes.push(32)
    else if (code < 32 || (code >= 127 && code < 160)) continue
    else if (code < 127 || (code >= 160 && code <= 255)) bytes.push(code)
    else bytes.push(WIN_ANSI[code] ?? 63)
  }
  return bytes
}

/** A PDF string literal in plain ASCII: brackets and backslashes escaped, bytes above 126 as octal escapes. */
function pdfString(text: string): string {
  let out = '('
  for (const byte of toWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, '0')}`
    else out += String.fromCharCode(byte)
  }
  return `${out})`
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

/** `#RRGGBB` as the three 0..1 numbers a PDF colour operator takes. */
function rgb(hex: string): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!match) throw new Error(`Not a #RRGGBB colour: ${hex}`)
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((part) => num(part / 255)).join(' ')
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

function pdfDate(date: Date): string {
  const p = (value: number, size = 2) => String(value).padStart(size, '0')
  return `D:${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
}

export type PdfImage = JpegInfo & { data: Uint8Array }

type PageImage = { name: string; image: PdfImage }
type Page = { ops: string[]; images: PageImage[] }

export type TextOptions = { size: number; font?: Font; /** `#RRGGBB`, default black. */ color?: string }
export type LineOptions = { width?: number; color?: string }
export type RectOptions = { stroke?: string; fill?: string; lineWidth?: number }

export class PdfBuilder {
  private readonly pages: Page[] = []
  private current: Page | null = null
  private readonly meta: { title: string; author?: string; created: Date }

  // No parameter property here: the tests run the file with Node's type stripping, which does not support them.
  constructor(meta: { title: string; author?: string; created: Date }) {
    this.meta = meta
  }

  get pageCount() {
    return this.pages.length
  }

  /** Starts a new page and makes it the one that is drawn on. */
  newPage() {
    this.current = { ops: [], images: [] }
    this.pages.push(this.current)
  }

  /** Makes an earlier page the one that is drawn on, for things like page numbers once the total is known. */
  usePage(index: number) {
    const page = this.pages[index]
    if (!page) throw new Error(`No page ${index}`)
    this.current = page
  }

  private page(): Page {
    if (!this.current) this.newPage()
    return this.current as Page
  }

  textWidth(text: string, size: number, font: Font = 'sans'): number {
    let total = 0
    for (const char of text) total += glyphWidth(char, font)
    return (total * size) / 1000
  }

  /** Breaks text into lines of at most `maxWidth` points. Paragraph breaks (\n) are kept; a word that is too long is cut. */
  wrap(text: string, maxWidth: number, size: number, font: Font = 'sans'): string[] {
    const lines: string[] = []
    for (const paragraph of text.split(/\r\n|\r|\n/)) {
      const words = paragraph.split(/[ \t]+/).filter(Boolean)
      if (words.length === 0) {
        lines.push('')
        continue
      }
      let line = ''
      const flush = () => {
        if (line) lines.push(line)
        line = ''
      }
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word
        if (this.textWidth(candidate, size, font) <= maxWidth) {
          line = candidate
          continue
        }
        flush()
        if (this.textWidth(word, size, font) <= maxWidth) {
          line = word
          continue
        }
        // A single word wider than the line, such as a long address or URL: cut it by characters.
        let piece = ''
        for (const char of word) {
          if (piece && this.textWidth(piece + char, size, font) > maxWidth) {
            lines.push(piece)
            piece = ''
          }
          piece += char
        }
        line = piece
      }
      flush()
    }
    return lines
  }

  /** One line of text with its baseline at `y`. */
  text(x: number, y: number, text: string, options: TextOptions) {
    const resource = FONT_RESOURCE[options.font ?? 'sans']
    this.page().ops.push(`q ${rgb(options.color ?? '#000000')} rg BT /${resource} ${num(options.size)} Tf ${num(x)} ${num(y)} Td ${pdfString(text)} Tj ET Q`)
  }

  line(x1: number, y1: number, x2: number, y2: number, options: LineOptions = {}) {
    this.page().ops.push(`q ${num(options.width ?? 0.5)} w ${rgb(options.color ?? '#bfbfbf')} RG ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S Q`)
  }

  rect(x: number, y: number, width: number, height: number, options: RectOptions = {}) {
    const parts = ['q']
    if (options.fill !== undefined) parts.push(`${rgb(options.fill)} rg`)
    if (options.stroke !== undefined) parts.push(`${num(options.lineWidth ?? 0.5)} w ${rgb(options.stroke)} RG`)
    parts.push(`${num(x)} ${num(y)} ${num(width)} ${num(height)} re`)
    parts.push(options.fill !== undefined && options.stroke !== undefined ? 'B' : options.fill !== undefined ? 'f' : 'S')
    parts.push('Q')
    this.page().ops.push(parts.join(' '))
  }

  /** Draws a JPEG with its lower left corner at (x, y), scaled to width x height points. */
  image(image: PdfImage, x: number, y: number, width: number, height: number) {
    const page = this.page()
    const name = `Im${page.images.length + 1}`
    page.images.push({ name, image })
    page.ops.push(`q ${num(width)} 0 0 ${num(height)} ${num(x)} ${num(y)} cm /${name} Do Q`)
  }

  /** The finished file. */
  build(): Uint8Array {
    if (this.pages.length === 0) this.newPage()
    const pages = this.pages

    // Object numbers: 1 catalog, 2 page tree, 3 to 5 fonts, 6 info; then per page its images, content and page.
    const FONT_REGULAR = 3
    const FONT_BOLD = 4
    const FONT_SERIF = 5
    const INFO = 6
    let next = 7
    const layout = pages.map((page) => {
      const images = page.images.map((entry) => ({ ...entry, id: next++ }))
      const content = next++
      const id = next++
      return { page, images, content, id }
    })

    const objects = new Map<number, Uint8Array[]>()
    const textObject = (id: number, body: string) => objects.set(id, [ascii(`${id} 0 obj\n${body}\nendobj\n`)])
    const streamObject = (id: number, dict: string, data: Uint8Array) =>
      objects.set(id, [ascii(`${id} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`), data, ascii('\nendstream\nendobj\n')])

    textObject(1, '<< /Type /Catalog /Pages 2 0 R >>')
    textObject(2, `<< /Type /Pages /Kids [${layout.map((item) => `${item.id} 0 R`).join(' ')}] /Count ${layout.length} >>`)
    textObject(FONT_REGULAR, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    textObject(FONT_BOLD, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
    textObject(FONT_SERIF, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>')
    textObject(
      INFO,
      `<< /Title ${pdfString(this.meta.title)} ${this.meta.author ? `/Author ${pdfString(this.meta.author)} ` : ''}/Producer (DIG Monteursdashboard) /CreationDate (${pdfDate(this.meta.created)}) >>`,
    )

    for (const item of layout) {
      for (const entry of item.images) {
        const { image } = entry
        streamObject(
          entry.id,
          `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.components === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode`,
          image.data,
        )
      }
      streamObject(item.content, '', ascii(item.page.ops.join('\n')))
      const xobjects = item.images.length ? ` /XObject << ${item.images.map((entry) => `/${entry.name} ${entry.id} 0 R`).join(' ')} >>` : ''
      textObject(
        item.id,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_WIDTH)} ${num(PAGE_HEIGHT)}] /Resources << /Font << /F1 ${FONT_REGULAR} 0 R /F2 ${FONT_BOLD} 0 R /F3 ${FONT_SERIF} 0 R >>${xobjects} >> /Contents ${item.content} 0 R >>`,
      )
    }

    const chunks: Uint8Array[] = []
    let offset = 0
    const push = (chunk: Uint8Array) => {
      chunks.push(chunk)
      offset += chunk.length
    }
    // The second line holds bytes above 127, which tells tools that the file is binary.
    push(ascii('%PDF-1.4\n'))
    push(Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a))

    const count = next
    const offsets = Array.from({ length: count }, () => 0)
    for (let id = 1; id < count; id++) {
      offsets[id] = offset
      for (const chunk of objects.get(id) as Uint8Array[]) push(chunk)
    }

    const xrefAt = offset
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
    xref += `trailer\n<< /Size ${count} /Root 1 0 R /Info ${INFO} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
    push(ascii(xref))

    const out = new Uint8Array(offset)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}
