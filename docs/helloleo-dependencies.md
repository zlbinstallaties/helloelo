# HelloLeo-afhankelijkheden

Dit document beschrijft alleen wat uit de repository en de beschikbare officiële projectdocumentatie aantoonbaar is. Onbekende onderdelen zijn expliciet gemarkeerd.

| Onderdeel | Aantoonbare implementatie | Interface/configuratie | Zelfstandige vervanging | Status |
|---|---|---|---|---|
| Runtime | `@helloleo/runtime` `0.1.6` in `package.json` | imports in `src/lib/cache.ts`, `src/lib/kv.ts`, `src/lib/storage.ts`, `src/db/index.ts` | Cloudflare Workers bindings of eigen serverruntime | Gebruikt |
| Build | `@helloleo/vite-config`, Vite en Cloudflare Vite-plugin | `vite.config.ts`, `bun run build` | Vite/TanStack Start-config voor gekozen hosting | Gebruikt |
| Integratieproxy | `callIntegration` in `src/lib/proxy.server.ts` | vaste `/api/integration-proxy/<project>` URL, `HELLOLEO_API_KEY` server-side | Eigen Odoo JSON-RPC client met serversecret en auth | Gebruikt |
| Cache | `withCache('odoo:dig-dashboard', 300, ...)` | 5 minuten; `.refresh()` via POST-route | Redis, KV, SQL of process cache, afhankelijk van deployment | Gebruikt |
| KV | Wrapper aanwezig in `src/lib/kv.ts` | `kv.get`, `put`, `delete`, `list` zijn gedocumenteerd; dashboard gebruikt deze wrapper niet direct | Eigen KV/Redis | Beschikbaar, niet gebruikt door dashboard |
| Object storage | Wrapper aanwezig in `src/lib/storage.ts` | `storage.get`, `put`, `delete`, `head`, `list`; dashboard gebruikt dit niet | S3-compatibele storage | Beschikbaar, niet gebruikt |
| Database | `createDb` in `src/db/index.ts`, voorbeeldtabel `notes` in `schema.ts` | Drizzle SQLite; `drizzle.config.ts`; `.dev.db` lokaal | SQLite/PostgreSQL/D1-equivalent | Scaffold/beschikbaar, niet gebruikt door dashboard |
| Preview | HelloLeo beheert een preview met TanStack Start SSR en platform-auth | preview-URL en platformomgeving; exacte serviceconfig is niet in repository | Eigen dev server plus preview deployment | Platformafhankelijk |
| Hosting | `src/server.ts` is een Cloudflare Worker-entry | `@helloleo/vite-config` bouwt richting Worker | Cloudflare Workers, Node SSR of andere Worker-hosting | Platformafhankelijk |

## Onbekend of niet afleidbaar

- De interne HelloLeo-proxyvalidatie, credentialopslag, preview-auth-middleware en productiepublicatiepipeline staan niet in deze repository.
- De precieze contractdetails van `@helloleo/runtime` buiten de gebruikte imports zijn niet zelfstandig uit deze code af te leiden.
- De Odoo-base-URL is alleen gebruikt voor een formulierlink; Odoo-credentials zijn niet zichtbaar.
- Self-hosting kan niet alleen door een environment variable worden gerealiseerd: proxy, cache, runtime en applicatie-auth moeten worden vervangen of opnieuw geïmplementeerd.

## Geheimen

Geen geheime waarden zijn in dit document opgenomen. `HELLOLEO_API_KEY` is alleen als naam genoemd. `.env`-bestanden, node_modules, lokale databases, logs en exports horen buiten Git te blijven.
