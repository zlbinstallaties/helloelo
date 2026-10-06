# DIG Monteursdashboard

Nederlandstalig, alleen-lezen dashboard voor `De Installatiegroep B.V. [TEST]`, gebouwd met TanStack Start en de verbonden Odoo 20-testomgeving.

## Bouwen en draaien

Vereist:

- Node.js 22+
- Bun 1.3+
- De DIG Odoo-gateway (`gateway/`) met een projecttoken voor dit dashboard

```bash
bun install
bun run build        # TanStack Start SSR voor Node
bun run start        # node scripts/serve.mjs, PORT (standaard 3000)
bun run dev          # ontwikkelserver op poort 5173
```

Server-omgeving (geen geheimen in browsercode):

| Variabele | Doel |
|---|---|
| `DIG_GATEWAY_URL` | adres van de Odoo-gateway, bijv. `http://odoo-gateway:8070` |
| `DIG_GATEWAY_TOKEN` | projecttoken voor dit dashboard (alleen-lezen) |
| `ODOO_PUBLIC_URL` | optioneel, alleen voor links naar Odoo-formulieren |

Het dashboard heeft geen Odoo-sleutel: de gateway bewaart die en geeft dit dashboard alleen
`planning.slot` en `svs.tech.visit` voor `company_id = 2`, alleen-lezen. Zonder gateway-instelling
geeft `/api/dashboard` een nette 503 en meldt `/api/health` `degraded`. De cache (5 minuten,
`POST /api/dashboard` ververst) draait in het geheugen van het serverproces (`src/lib/ttl-cache.ts`).

Er zijn geen HelloLeo-, Cloudflare- of Drizzle-afhankelijkheden meer. Een app als deze draait
in de DIG Builder-sandbox als preview (`docs/dig-builder-sandbox.md`).

## Documentatie

- `docs/architecture.md`: huidige request- en dataarchitectuur
- `docs/helloleo-dependencies.md`: HelloLeo-koppelingen en hoe ze zijn vervangen
- `docs/build-workflow.md`: uitgevoerde en voorgestelde overdrachtswerkwijze
- `docs/dig-builder-design.md`: ontwerp voor een toekomstige beheerdergerichte Odoo-module
- `docs/verification.md`: uitgevoerde controles, tekortkomingen en open risico's
- `docs/extern-platform-plan.md`: plan voor het eigen builder-platform
- `docs/odoo-gateway.md`: Odoo-gateway met allowlist per project (fase 1)
- `docs/dig-builder-agent.md`: agent-loop die een app aanpast en het resultaat als branch en diff oplevert (fase 2)
- `docs/dig-builder-sandbox.md`: sandbox-containers en previews achter login (fase 3)
- `docs/dig-builder-install.md`: het installatiescript voor de Hostinger-VPS (naast een bestaande Caddy)
- `docs/dig-builder-deploy.md`: handmatige installatie (gateway, previews, TLS) voor een server zonder webserver
- `docs/builder-app.md`: het scherm om opdrachten te geven en wijzigingen goed te keuren (fase 4)
- `docs/proefrun.md`: eerste echte run van de agent op het dashboard (`scripts/proefrun.sh`)

## Export en veiligheid

Neem bij een export de bronbestanden, `package.json`, `bun.lock`, `tsconfig.json`, `vite.config.ts` en `src/` mee.

Sluit altijd uit:

- `.env` en andere bestanden met secrets
- `node_modules/`
- lokale build-output (`dist/`)
- geëxporteerde Odoo-records, klantgegevens en runtime-logs

Credentials mogen niet naar de browserbundel worden verplaatst. De app heeft zelf geen
gebruikerslogin; zet hem achter de preview-proxy (`sandbox/`) of een eigen login voordat je hem
breder deelt. Odoo Enterprise-broncode hoort niet in deze repository.

## DIG Builder (fase 2)

De map `builder/` bevat een onafhankelijke buildservice-basis, een runner-healthgrens en een Odoo-addon-skelet. Start deze services met:

```bash
docker compose up --build
```

Zet eerst `BUILDER_ADMIN_TOKEN` en providercredentials in een lokale `.env`. De providerstatus meldt expliciet wanneer een provider niet is ingesteld; er is geen stille fallback of gesimuleerde AI. De runner voert in deze fase nog geen gegenereerde code uit.

### Geisoleerde Odoo 20-integratietest

De addon-tests kunnen lokaal worden uitgevoerd in een aparte Compose-stack. Deze
stack gebruikt een eigen database, volumes en netwerk en verwijdert die na afloop.
Er worden geen providercredentials of echte AI-aanroepen gebruikt:

```bash
sh scripts/run-dig-builder-integration.sh
```

De huidige omgeving bevat geen Docker/Odoo-runner, dus deze controle is alleen
geschreven en niet hier uitgevoerd. De hoofdstack en bestaande databases worden
door dit script niet gebruikt. De uitvoermap wordt na afloop afgedrukt en bevat
de testuitvoer, containerlogs, Compose-status en exitstatus.
