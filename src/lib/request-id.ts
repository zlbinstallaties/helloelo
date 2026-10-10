/*
 * A fresh id for one "add a technician" request. The browser makes it when the form opens and keeps it for every
 * retry of that request, so that the server can tell a repeat from a new request. `randomUUID` only exists on
 * https pages and localhost; elsewhere random bytes are used.
 */

type RandomSource = {
  randomUUID?: () => string
  getRandomValues?: (bytes: Uint8Array) => Uint8Array
}

export function newRequestId(source: RandomSource = globalThis.crypto as RandomSource): string {
  if (typeof source?.randomUUID === 'function') return source.randomUUID()
  if (typeof source?.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16))
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  throw new Error('This browser has no source of random numbers.')
}
