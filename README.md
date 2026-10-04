# DIG Monteursdashboard

Nederlandstalig, alleen-lezen dashboard voor `De Installatiegroep B.V. [TEST]`, gebouwd met TanStack Start en de verbonden Odoo 20-testomgeving.

## Bouwen

Vereist:

- Node.js 26+
- Bun 1.3+
- Een geconfigureerde HelloLeo-projectomgeving met Odoo-verbinding

Installeer dependencies en bouw de app:

```bash
bun install
bun run build
```

Voor lokale ontwikkeling:

```bash
bun run dev
```

## HelloLeo-afhankelijkheden

- `@helloleo/runtime` voor server-runtime en de zichtbare cache met een TTL van 5 minuten
- HelloLeo Integration Proxy voor server-side Odoo-leesacties
- `HELLOLEO_API_KEY` blijft server-side en hoort niet in browsercode
- De app gebruikt geen Odoo-API-sleutel in de bronbestanden

De dashboardroute leest uitsluitend:

- `planning.slot` via `search_read`
- `svs.tech.visit` via `search_read`

De serverroute beperkt de data tot `company_id = 2`, `De Installatiegroep B.V. [TEST]`. Er worden geen Odoo-records aangemaakt, gewijzigd of verwijderd en er worden geen berichten verstuurd.

## Documentatie

- `docs/architecture.md`: huidige request- en dataarchitectuur
- `docs/helloleo-dependencies.md`: aantoonbare HelloLeo-koppelingen en zelfstandige vervangingen
- `docs/build-workflow.md`: uitgevoerde en voorgestelde overdrachtswerkwijze
- `docs/dig-builder-design.md`: ontwerp voor een toekomstige beheerdergerichte Odoo-module
- `docs/verification.md`: uitgevoerde controles, tekortkomingen en open risico's

## Export en veiligheid

Neem bij een handmatige export wel de bronbestanden, `package.json`, `bun.lock`, `tsconfig.json`, `vite.config.ts`, `wrangler`-/Drizzle-configuratie en `src/` mee.

Sluit altijd uit:

- `.env` en andere bestanden met secrets
- `node_modules/`
- lokale build-output
- cachebestanden
- geëxporteerde Odoo-records, klantgegevens en runtime-logs

De onafhankelijke hosting van deze app vereist een vervanging van de HelloLeo Proxy en een eigen server-side Odoo-authenticatie- en cachelaag. Credentials mogen niet naar de browserbundel worden verplaatst.

## Zelfstandige hosting

Zelfstandig hosten is niet direct plug-and-play. Vervang minimaal de HelloLeo Integration Proxy, `@helloleo/runtime`-cache en Cloudflare-runtime door eigen server-side equivalenten. Behoud de Odoo-credentials uitsluitend als serversecret, voeg echte applicatie-authenticatie en autorisatie toe en test de Odoo 20-veldnamen opnieuw in de doelomgeving. Odoo Enterprise-broncode hoort niet in deze repository.
