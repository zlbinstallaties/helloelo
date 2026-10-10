/*
 * The size of photos on the phone. Pure maths, no browser, so it is unit-tested in test/; the canvas that applies it is
 * in photo-browser.ts. A photo of a modern phone is several MB; a document with a few of them would not go through a
 * mobile connection or into the PDF. Photos are scaled to 1600 px on the long side at JPEG quality 0.8 (about 250 KB),
 * and when one is still too big for the server (`LIMITS.photoChars`) it is tried again smaller.
 */

export const PHOTO_MAX_SIDE = 1600

export type PhotoAttempt = { width: number; height: number; quality: number }

/** The size within `max` on the long side, with the same shape; a smaller photo stays as it is. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The settings to try one after the other until the photo is small enough; none is bigger or better than the one before. */
export function photoAttempts(width: number, height: number): PhotoAttempt[] {
  return [
    { max: PHOTO_MAX_SIDE, quality: 0.8 },
    { max: PHOTO_MAX_SIDE, quality: 0.65 },
    { max: 1280, quality: 0.65 },
    { max: 1024, quality: 0.6 },
    { max: 800, quality: 0.55 },
  ].map(({ max, quality }) => ({ ...fitWithin(width, height, max), quality }))
}
