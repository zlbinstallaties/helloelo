import { LOCKUP, LOCKUP_MARK, MARK_BAR, MARK_BOX, MARK_D, WORDMARK_PATHS } from '#/lib/documents/logo'

/*
 * The logo of De Installatiegroep, from the logo pack of the company: a copper bar and a navy "D" (the mark), and the wordmark
 * "De Installatiegroep" (Inter Medium, drawn as outlines, so no font is needed). The geometry is in src/lib/documents/logo.ts and
 * is the same as in the PDF.
 *
 * The colours are tokens (src/styles.css), so the right variant of the pack shows by itself: on a light ground the copper bar and
 * the ink are the "kleur" variant (copper #B87333, navy #16283C); on a dark ground the "inverse" variant (copper #CA8E56, off-white
 * #F7F5F1). The pack asks for at least 180 px for the lock-up and 20 px for the mark.
 */

/** The horizontal lock-up: mark and wordmark. Give it a height of at least 2.75rem (44 px, so 197 px wide). */
export function Logo({ className = 'h-11 w-auto' }: { className?: string }) {
  const { x, y, scale } = LOCKUP_MARK
  return (
    <svg viewBox={`0 0 ${LOCKUP.width} ${LOCKUP.height}`} className={className} role="img" aria-label="De Installatiegroep" fill="none">
      <g transform={`translate(${x} ${y}) scale(${scale}) translate(${-MARK_BAR.x} ${-MARK_BAR.y})`}>
        <rect x={MARK_BAR.x} y={MARK_BAR.y} width={MARK_BAR.width} height={MARK_BAR.height} className="fill-seam" />
        <path d={MARK_D} fillRule="evenodd" className="fill-foreground" />
      </g>
      {WORDMARK_PATHS.map((d, index) => <path key={index} d={d} className="fill-foreground" />)}
    </svg>
  )
}

/** Only the mark, for small places (under 120 px wide). */
export function LogoMark({ className = 'size-9' }: { className?: string }) {
  return (
    <svg viewBox={`${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`} className={className} role="img" aria-label="De Installatiegroep" fill="none">
      <rect x={MARK_BAR.x} y={MARK_BAR.y} width={MARK_BAR.width} height={MARK_BAR.height} className="fill-seam" />
      <path d={MARK_D} fillRule="evenodd" className="fill-foreground" />
    </svg>
  )
}
