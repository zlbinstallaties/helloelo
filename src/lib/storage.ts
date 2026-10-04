import { storage } from '@helloleo/runtime'

/**
 * File/object storage — @helloleo/runtime `storage`. Use this file as the
 * base for uploads, images, exports and any binary data. Same import in dev
 * and production; never install @aws-sdk/*, multer, or use node:fs.
 *
 * The raw contract:
 *
 *   await storage.put('avatars/u1.png', bytes, { contentType: 'image/png' })
 *   await storage.get('avatars/u1.png')   // { body: ReadableStream, size, contentType } | null
 *   await storage.head('avatars/u1.png')  // { size, contentType } | null
 *   await storage.delete('avatars/u1.png')
 *   await storage.list({ prefix: 'avatars/', limit: 100 })  // { keys: [{ key, size }], cursor }
 *
 * Rules:
 * - Server-side only (route handlers, loaders, server functions).
 * - Files flow THROUGH YOUR API ROUTES: upload = POST route reads the body
 *   and `storage.put`s it; download = GET route streams `obj.body` back.
 *   Do NOT use presignGet/presignPut — presigned URLs are not available.
 * - Key layout is up to the app — namespace with prefixes ('avatars/',
 *   'exports/'). Store the key in a database row to reference the file.
 *
 * Upload route example (src/routes/api/images/upload.ts):
 *
 *   POST: async ({ request }) => {
 *     const form = await request.formData()
 *     const file = form.get('file') as File
 *     const key = `images/${crypto.randomUUID()}-${file.name}`
 *     await storage.put(key, file.stream(), { contentType: file.type })
 *     return Response.json({ key }, { status: 201 })
 *   }
 *
 * Download/serve route example (src/routes/api/images/$key.ts):
 *
 *   GET: async ({ params }) => {
 *     const obj = await storage.get(`images/${params.key}`)
 *     if (!obj) return new Response('Not found', { status: 404 })
 *     return new Response(obj.body, {
 *       headers: { 'content-type': obj.contentType ?? 'application/octet-stream' },
 *     })
 *   }
 */

export { storage }
