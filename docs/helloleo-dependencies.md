# HelloLeo-afhankelijkheden (vervangen)

Het dashboard draaide oorspronkelijk op het HelloLeo-platform. Die koppelingen zijn vervangen,
zodat de app zelfstandig bouwt en draait en in de DIG Builder-sandbox als preview kan werken.

| Onderdeel | Was | Nu |
|---|---|---|
| Runtime | `@helloleo/runtime` | Geen. Node-processen, eigen `src/lib/ttl-cache.ts` |
| Build | `@helloleo/vite-config` + Cloudflare Vite-plugin | `vite.config.ts` met TanStack Start, Tailwind en React; Vite 8 (`resolve.tsconfigPaths`) |
| Odoo-toegang | HelloLeo Integration Proxy met `HELLOLEO_API_KEY` | DIG Odoo-gateway met een projecttoken (`src/lib/gateway.server.ts`) |
| Cache | `withCache` uit `@helloleo/runtime` | `withCache` uit `src/lib/ttl-cache.ts` (5 minuten, `refresh()`, gedeelde lopende lezing) |
| KV, storage, database | wrappers in `src/lib/kv.ts`, `storage.ts`, `src/db` (Drizzle/D1) | Verwijderd: het dashboard gebruikte ze niet |
| Hosting | Cloudflare Worker-entry | `scripts/serve.mjs` (srvx op Node) serveert `dist/client` en de server-entry |
| Preview | HelloLeo-preview met platform-auth | `sandbox/` preview-proxy met login |

Verwijderd uit de repository: `@helloleo/*`, `@cloudflare/*`, `wrangler`, `drizzle-orm`,
`drizzle-kit`, `@libsql/client`, `vite-tsconfig-paths`, `drizzle/`, `.leo/`, `src/db/`.

De licentie van `@helloleo/vite-config` is `UNLICENSED`: de nieuwe `vite.config.ts` is zelf
geschreven en neemt er geen code uit over.

## Nog open

- De app heeft zelf geen gebruikerslogin (zie `docs/architecture.md`).
- De cache zit in het geheugen van één serverproces; bij meerdere instanties heeft elke instantie
  een eigen cache.
- De gateway-projectconfig voor dit dashboard staat in `gateway/projects.example.json`.
