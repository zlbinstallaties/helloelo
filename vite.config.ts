import { defineConfig } from '@helloleo/vite-config'

// @helloleo/vite-config owns the whole build/dev/sandbox pipeline: in dev it
// aliases `cloudflare:workers` -> @helloleo/runtime/cf-shim (libsql .dev.db for
// D1+KV, local disk for R2) and runs plain Vite SSR; at build it adds
// @cloudflare/vite-plugin to emit a workerd Worker bound to wrangler.jsonc. It
// also binds host:true/port:5173 itself (>=0.1.2) and blocks *.server.* files
// from the client bundle (>=0.1.7).
//
// No HMR override: with no clientPort set, the Vite client connects back to the
// page's own origin, which is wss://…:443 behind the preview proxy.
export default defineConfig()
