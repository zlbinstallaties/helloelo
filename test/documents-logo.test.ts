import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FORMS } from '../src/lib/documents/forms.ts'
import { LOCKUP, LOCKUP_MARK, MARK_BAR, MARK_BOX, MARK_D, WORDMARK_PATHS, mapSegments, markSegments, parsePath } from '../src/lib/documents/logo.ts'
import type { PathSegment } from '../src/lib/documents/logo.ts'
import { renderDocumentPdf } from '../src/lib/documents/render.ts'
import { validateSubmission } from '../src/lib/documents/submission.ts'
import { SIGNATURE } from './documents-fixtures.ts'

/** The box round a list of segments (control points included, which only makes it a little bigger). */
function box(segments: readonly PathSegment[]) {
  const xs: number[] = []
  const ys: number[] = []
  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 2) {
      xs.push(segment[index] as number)
      ys.push(segment[index + 1] as number)
    }
  }
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

test('the mark is the one of the logo pack: a copper bar of 11 x 48 and a D of two half discs next to it', () => {
  assert.deepEqual(MARK_BAR, { x: 6, y: 8, width: 11, height: 48 })
  assert.equal(MARK_D, 'M25 8 H33 A24 24 0 0 1 33 56 H25 Z M25 19 H33 A13 13 0 0 1 33 45 H25 Z')
  assert.deepEqual(MARK_BOX, { x: 6, y: 8, width: 51, height: 48 })
  const d = box(markSegments())
  assert.deepEqual([d.left, d.right, d.top, d.bottom], [25, 57, 8, 56], 'the D spans x 25 to 57 and y 8 to 56, as in the pack')
})

test('the curves of the D are the half discs: the middle of each curve is on the circle', () => {
  const segments = markSegments()
  const curves = segments.filter((segment): segment is Extract<PathSegment, readonly ['C', ...number[]]> => segment[0] === 'C')
  assert.equal(curves.length, 4)
  // The first curve of each half disc goes from the top to the right-most point of a circle with its centre at x 33.
  for (const [curve, radius, centreY] of [[curves[0], 24, 32], [curves[2], 13, 32]] as const) {
    const start = segments[segments.indexOf(curve) - 1]
    const [x0, y0] = [start[1] as number, start[2] as number]
    const [x1, y1, x2, y2, x3, y3] = curve.slice(1) as number[]
    const middle = [(x0 + 3 * x1 + 3 * x2 + x3) / 8, (y0 + 3 * y1 + 3 * y2 + y3) / 8]
    const distance = Math.hypot(middle[0] - 33, middle[1] - centreY)
    assert.ok(Math.abs(distance - radius) < 0.05, `radius ${radius}: ${distance}`)
    assert.deepEqual([x3, y3], [33 + radius, centreY])
  }
})

test('in the lock-up the mark sits where the pack puts it: translate(36.667 36.667) scale(10/3)', () => {
  assert.ok(Math.abs(LOCKUP_MARK.x - 36.6667) < 1e-3 && Math.abs(LOCKUP_MARK.y - 36.6667) < 1e-3 && Math.abs(LOCKUP_MARK.scale - 3.3333) < 1e-3)
  const inLockup = box(mapSegments(markSegments(), (x, y) => [LOCKUP_MARK.x + (x - 6) * LOCKUP_MARK.scale, LOCKUP_MARK.y + (y - 8) * LOCKUP_MARK.scale]))
  assert.ok(Math.abs(inLockup.left - 100) < 0.01 && Math.abs(inLockup.right - 206.667) < 0.01, 'the D from x 100 to 206.7')
  assert.ok(Math.abs(inLockup.top - 36.667) < 0.01 && Math.abs(inLockup.bottom - 196.667) < 0.01, 'and from y 36.7 to 196.7, as high as the bar')
})

test('the wordmark is two outlines inside the lock-up, to the right of the mark, and nothing in it is a command we do not draw', () => {
  assert.equal(WORDMARK_PATHS.length, 2)
  for (const d of WORDMARK_PATHS) {
    const segments = parsePath(d)
    assert.ok(segments.length > 50)
    assert.deepEqual([...new Set(segments.map((segment) => segment[0]))].sort(), ['C', 'L', 'M', 'Z'])
    const b = box(segments)
    assert.ok(b.left > 206.667 + 30, `starts clear of the mark: ${b.left}`)
    assert.ok(b.right < LOCKUP.width && b.top >= 0 && b.bottom <= LOCKUP.height, 'inside the lock-up')
  }
})

test('a path reader that refuses what it cannot draw, and turns a quadratic curve into the same curve as a cubic one', () => {
  assert.deepEqual(parsePath('M0 0Q3 6 6 0Z'), [['M', 0, 0], ['C', 2, 4, 4, 4, 6, 0], ['Z']])
  assert.deepEqual(parsePath('M1 2 L3 4 5 6'), [['M', 1, 2], ['L', 3, 4], ['L', 5, 6]], 'a second pair of numbers repeats the command')
  assert.throws(() => parsePath('M0 0A5 5 0 0 1 10 0'), /Unsupported/)
  assert.throws(() => parsePath('M0 0 S1 1 2 2'), /Unsupported/)
  assert.throws(() => parsePath('m0 0 l1 1'), /Unsupported/, 'relative commands are not drawn')
  assert.throws(() => parsePath('M0 0 # L1 1'), /Unexpected character/)
  assert.throws(() => parsePath('1 2'), /Unexpected/)
  assert.throws(() => parsePath('M1'), /Unexpected end/)
})

test('the letterhead of the PDF is the logo drawn as shapes: the D with the even-odd rule, lots of curves, and not the old square', () => {
  const form = FORMS.schouw
  const checked = validateSubmission(form, {
    author: 'Jan de Vries',
    answers: { parkeren: { value: 'ja' }, huisdieren: { value: 'nee' }, werkzaamheden: 'sanitair', meterkast: { value: 'nvt' }, asbest: { value: 'nee' } },
    signature: { name: 'Mevr. Jansen', image: SIGNATURE },
  })
  assert.ok(checked.ok)
  const pdf = Buffer.from(
    renderDocumentPdf(form, { companyName: 'Test', customer: 'Jansen', address: 'Straat 1', appointmentTitle: 'Schouw', appointmentDate: '2026-10-15', people: ['Jan'], createdAt: new Date('2026-10-15T10:00:00Z') }, checked.value),
  ).toString('latin1')
  assert.ok(pdf.includes(' f* Q'), 'the D has a hole in it')
  assert.ok((pdf.match(/ c /g) ?? []).length > 300, 'the wordmark is made of curves')
  // The first thing on the page is the bar of the logo: copper, 11 x 48 units of the mark at 30 points high (so 4.64 x 20.25 points).
  const first = /q ([\d. ]+) rg ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re f Q/.exec(pdf)
  assert.ok(first, 'a filled rectangle')
  assert.equal(first[1], '0.72 0.45 0.2', 'copper (#B87333)')
  assert.deepEqual([first[4], first[5]], ['4.64', '20.25'])
  assert.ok(pdf.indexOf(first[0]) < pdf.indexOf(' f* Q'), 'the bar comes before the D')
  assert.ok(!pdf.includes('(De Installatiegroep) Tj'), 'the wordmark is no longer text in a stand-in typeface')
})

test('the icon of the browser tab is the mark in the inverse colours on a navy tile', () => {
  const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
  assert.ok(svg.includes(`d="${MARK_D}"`), 'the same D')
  for (const colour of ['#16283C', '#CA8E56', '#F7F5F1']) assert.ok(svg.includes(colour), colour)
  assert.ok(/x="6" y="8" width="11" height="48"/.test(svg), 'the same bar')
})
