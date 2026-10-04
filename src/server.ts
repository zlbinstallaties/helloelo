// Cloudflare Worker entry (the Worker `main`, configured by @helloleo/vite-config).
// Wraps the TanStack Start server entry so an SSR failure renders a clean 500
// instead of a raw stack.
type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response
}

let serverEntryPromise: Promise<ServerEntry> | undefined

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import('@tanstack/react-start/server-entry').then(
      (m) => ((m as { default?: ServerEntry }).default ?? m) as ServerEntry,
    )
  }
  return serverEntryPromise
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry()
      return await handler.fetch(request, env, ctx)
    } catch (error) {
      console.error(error)
      return new Response('<h1>Something went wrong</h1>', {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
  },
}
