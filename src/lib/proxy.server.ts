import '@tanstack/react-start/server-only'
import { env } from '@helloleo/runtime'

/*
 * HelloLeo Integration Proxy: server-side helper for connected integrations.
 *
 * All third-party APIs (Odoo, Airtable, HubSpot, Stripe, Notion, Gladia,
 * Microsoft 365, Klaviyo, Supabase, DimoMaint, etc.) are reachable through
 * this single proxy. The proxy holds the credentials the user configured in
 * Project Settings -- you NEVER pass an integration's API key yourself, and you
 * NEVER call third-party hosts directly.
 *
 * SERVER-ONLY. Every call carries this project's HELLOLEO_API_KEY, which only
 * exists on the server. Importing this file from browser code fails the build
 * (the import above, plus the .server.ts name). Call it from a server route
 * under src/routes/api/ and fetch that route from the page with react-query:
 *
 *   // src/routes/api/products.ts
 *   import { createFileRoute } from '@tanstack/react-router'
 *   import { callIntegration } from '#/lib/proxy.server'
 *
 *   export const Route = createFileRoute('/api/products')({
 *     server: {
 *       handlers: {
 *         GET: async () => {
 *           const r = await callIntegration({
 *             integration: 'odoo',
 *             endpoint: '/jsonrpc',
 *             body: {
 *               model: 'product.template',
 *               method: 'search_read',
 *               args: [[['type', '=', 'consu']]],
 *               kwargs: { fields: ['name', 'list_price'], limit: 50 },
 *             },
 *           })
 *           if (!r.success) return Response.json({ error: r.data }, { status: 502 })
 *           return Response.json(r.data?.result ?? [])
 *         },
 *       },
 *     },
 *   })
 *
 * One route per operation the app needs. NEVER write a route that forwards
 * `integration`, `endpoint`, `model`, `method` or a raw body from the request
 * to callIntegration: that hands every visitor the user's full integration
 * access, with this project's key attached.
 *
 * Integration slugs:
 *   Use the exact slug from the Enabled MCP list with the "pipedream-"
 *   prefix removed. e.g. "pipedream-gorgias_oauth" -> "gorgias_oauth".
 *   Native integrations (odoo, airtable) keep their plain name.
 *
 * Response shape (always wrapped):
 *   { success: boolean, status: number, data: <provider payload>, docs: string }
 *
 *   - `status` is the UPSTREAM status, not the proxy's.
 *   - `success` is false whenever that status is >= 400.
 *   - `data` is null when the upstream returned no body.
 *   - `docs` links the proxy's own reference.
 *
 *   Unwrap "data" by provider:
 *     odoo            -> data.result
 *     airtable        -> data.records
 *     notion          -> data.results
 *     microsoft 365   -> data.value
 *     klaviyo         -> data.data
 *     supabase / dimomaint -> data
 *
 *   A 401 with code "api_key_missing" or "api_key_invalid" comes from the
 *   proxy itself: the call ran without this project's key. Its `llm` field
 *   says what to change.
 *
 * Pagination: put query params directly in the endpoint string,
 *   e.g. endpoint: '/api/tickets?cursor=xyz&per_page=100'.
 *   Read pagination metadata from the response to build the next call.
 *   Never .filter() large lists in the page -- paginate in the route.
 *
 * Sending files:
 *   Most APIs take a file as base64 inside the normal JSON body. Odoo is the
 *   common case: ir.attachment.create with the bytes in `datas` and BOTH
 *   `res_model` and `res_id` set, or the file is stored but appears on no
 *   record. Nothing special is needed for those.
 *
 *   Some upload endpoints accept only multipart/form-data and answer JSON with
 *   HTTP 415. For those set bodyEncoding: 'multipart' (see uploadFile below).
 *   Never set a Content-Type header for multipart, the proxy lets fetch
 *   generate the boundary. Not accepted for odoo, which has no multipart API.
 *
 *   Either way the browser POSTs the file to one of the app's own routes as
 *   FormData; the route reads it with `await request.formData()` and encodes
 *   it with fileToBase64 below.
 *
 * Secrets for non-integration APIs (e.g. raw OpenAI): store them in the
 * project's Variables and read them via `env` from @helloleo/runtime, in
 * server code only.
 */

export const INTEGRATION_PROXY_URL = 'https://api.app.helloleo.dev/api/integration-proxy/odoo-test-environment-analyzer-d0fe27b6-7dd6-471b-9b9e-46a2d336ab06'

// This project's key, issued by HelloLeo per target and injected into the
// server env: the preview holds one value, the published app another. The
// proxy reads which one it got to pick the integration connection, so the
// published app talks to production and the preview to development with no
// flag to set. Not in @helloleo/runtime's RuntimeEnv, hence the local shape.
const platformEnv = env as unknown as { HELLOLEO_API_KEY?: string }

function proxyHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = platformEnv.HELLOLEO_API_KEY
  if (key) headers.Authorization = `Bearer ${key}`
  return headers
}

export interface MultipartFile {
  /** Form field name the upstream expects, e.g. 'content' or 'file'. */
  name: string
  filename: string
  contentType?: string
  /** File bytes, base64-encoded (no data: prefix). */
  dataBase64: string
}

export interface MultipartBody {
  fields?: Record<string, string>
  files?: MultipartFile[]
}

export interface ProxyRequest {
  integration: string
  endpoint: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
  /** Omit for JSON. 'multipart' when the upstream upload endpoint rejects JSON with 415. */
  bodyEncoding?: 'json' | 'multipart'
}

export interface ProxyResponse<T = unknown> {
  success: boolean
  /** The UPSTREAM status, not the proxy's. */
  status: number
  /** Null when the upstream returned no body. */
  data: T | null
  /** The proxy's own reference, on every response. */
  docs: string
}

export async function callIntegration<T = unknown>(
  req: ProxyRequest,
): Promise<ProxyResponse<T>> {
  if (req.integration.toLowerCase() === 'netsuite') {
    throw new Error(
      "NetSuite is not proxied -- call it from this app's own /auth/netsuite + " +
        "/api server routes with the signed-in user's session, not callIntegration().",
    )
  }
  const res = await fetch(INTEGRATION_PROXY_URL, {
    method: 'POST',
    headers: proxyHeaders(),
    body: JSON.stringify({ method: 'POST', ...req }),
  })
  return res.json()
}

/**
 * Upload a file to an integration whose endpoint requires multipart/form-data
 * (Zoho WorkDrive and similar). For Odoo, do NOT use this -- create an
 * ir.attachment with the bytes base64-encoded in `datas` instead.
 */
export async function uploadFile<T = unknown>(
  req: Omit<ProxyRequest, 'body' | 'bodyEncoding'> & { body: MultipartBody },
): Promise<ProxyResponse<T>> {
  return callIntegration<T>({ method: 'POST', ...req, bodyEncoding: 'multipart' })
}

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/* Example -- multipart upload (Zoho WorkDrive), inside a POST route handler:
 *
 *   POST: async ({ request }) => {
 *     const form = await request.formData()
 *     const file = form.get('file') as File
 *     const r = await uploadFile({
 *       integration: 'zoho_workdrive',
 *       endpoint: '/api/v1/upload',
 *       body: {
 *         fields: { parent_id: FOLDER_ID, 'override-name-exist': 'true' },
 *         files: [{
 *           name: 'content',
 *           filename: file.name,
 *           contentType: file.type,
 *           dataBase64: await fileToBase64(file),
 *         }],
 *       },
 *     })
 *     if (!r.success) return Response.json({ error: r.data }, { status: 502 })
 *     return Response.json(r.data)
 *   }
 */
