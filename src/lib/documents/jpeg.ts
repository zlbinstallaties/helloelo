/*
 * Just enough JPEG to put a photo in a PDF unchanged (the PDF embeds the JPEG bytes as they are, so there is no
 * image library). Reads the size and the number of colour channels from the file and refuses what a PDF cannot show.
 */

export type JpegInfo = { width: number; height: number; components: 1 | 3 }

const MAX_SIDE = 12_000

/** Decodes `data:image/jpeg;base64,...` into bytes; null when it is not that. */
export function dataUrlToBytes(url: string): Uint8Array | null {
  const prefix = 'data:image/jpeg;base64,'
  if (!url.startsWith(prefix)) return null
  let binary: string
  try {
    binary = atob(url.slice(prefix.length))
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Baseline and progressive JPEG with one (grey) or three (colour) channels. Anything else, a cut-off file, or a
 * file that is not a JPEG gives null. CMYK and arithmetic coding are refused because PDF viewers differ on them.
 */
export function parseJpeg(bytes: Uint8Array): JpegInfo | null {
  const length = bytes.length
  if (length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  if (bytes[length - 2] !== 0xff || bytes[length - 1] !== 0xd9) return null

  let i = 2
  while (i + 3 < length) {
    if (bytes[i] !== 0xff) return null
    let marker = bytes[i + 1]
    // Any number of 0xFF fill bytes may precede a marker.
    while (marker === 0xff && i + 2 < length) {
      i++
      marker = bytes[i + 1]
    }
    i += 2
    // Markers without a length: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
    if (i + 1 >= length) return null
    const segment = (bytes[i] << 8) | bytes[i + 1]
    if (segment < 2) return null
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      // Only baseline (C0), extended sequential (C1) and progressive (C2).
      if (marker > 0xc2 || i + 7 >= length) return null
      if (bytes[i + 2] !== 8) return null
      const height = (bytes[i + 3] << 8) | bytes[i + 4]
      const width = (bytes[i + 5] << 8) | bytes[i + 6]
      const components = bytes[i + 7]
      if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return null
      if (components !== 1 && components !== 3) return null
      return { width, height, components }
    }
    // Start of scan before any frame header: not a usable file.
    if (marker === 0xda) return null
    i += segment
  }
  return null
}
