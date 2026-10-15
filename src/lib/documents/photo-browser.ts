import { photoAttempts } from './photo.ts'
import { LIMITS } from './submission.ts'

/*
 * Turns a photo from the camera (or the gallery) into a JPEG that fits the document: at most 1600 px on the long side,
 * quality 0.8, and smaller still when it is not small enough for the server yet. Browser only (canvas); the maths is in
 * photo.ts and is unit-tested.
 */

export class PhotoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhotoError'
  }
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void }

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      // The camera's rotation is applied, so a photo taken upright is not stored on its side.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch {
      // Fall through to an image element.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    throw new PhotoError('Deze foto kan niet worden gelezen. Maak een nieuwe foto.')
  }
}

export async function shrinkPhoto(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) throw new PhotoError('Dit bestand is geen foto.')
  const decoded = await decode(file)
  try {
    if (!decoded.width || !decoded.height) throw new PhotoError('Deze foto kan niet worden gelezen. Maak een nieuwe foto.')
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new PhotoError('Foto\'s verkleinen lukt niet in deze browser.')
    for (const attempt of photoAttempts(decoded.width, decoded.height)) {
      canvas.width = attempt.width
      canvas.height = attempt.height
      // A JPEG has no see-through parts: a transparent PNG would turn black without this.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, attempt.width, attempt.height)
      context.drawImage(decoded.source, 0, 0, attempt.width, attempt.height)
      const url = canvas.toDataURL('image/jpeg', attempt.quality)
      if (url.startsWith('data:image/jpeg;base64,') && url.length <= LIMITS.photoChars) return url
    }
    throw new PhotoError('Deze foto is te groot, ook na verkleinen. Maak een nieuwe foto.')
  } finally {
    decoded.release()
  }
}
