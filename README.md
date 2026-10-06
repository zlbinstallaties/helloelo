# DIG Monteursdashboard

Nederlandstalig, alleen-lezen dashboard voor `De Installatiegroep B.V. [TEST]`, gebouwd met TanStack Start en de verbonden Odoo 20-testomgeving.

Naast het dashboard staat in deze repository het **DIG Builder-platform**: een agent die een app zoals dit
dashboard aanpast op een eigen branch, een sandbox met previews, een Odoo-gateway en een scherm om
wijzigingen goed te keuren en te publiceren.

| Map | Inhoud |
|---|---|
| `src/`, `test/` | het dashboard (TanStack Start) en zijn tests |
| `gateway/` | Odoo-gateway: het enige onderdeel met de Odoo-sleutel, allowlist per project |
| `agent/` | de agent-loop die een app aanpast en een branch met diff oplevert |
| `sandbox/` | containers voor installatie, checks en previews achter login |
| `builder-app/` | het scherm om opdrachten te geven, goed te keuren en te publiceren |
| `builder/` | Odoo-addon-skelet, buildservice (Python) en runner (fase 2, Odoo-module-variant) |
| `deploy/` | installatiebestanden voor de Hostinger-VPS |
| `scripts/` | productieserver, demodata, `probe`, proefrun |
| `docs/` | documentatie, zie hieronder |

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

## Controles

Alle commando's draaien zonder echte Odoo en zonder Docker-daemon; de Docker-integratietests van de
sandbox slaan zichzelf dan over.

```bash
bun install
bun run typecheck && bun run lint && bun run build && bun run test:app   # dashboard
bun run test:odoo && bun run test:gateway && bun run typecheck:gateway   # Odoo-client en gateway
bun run test:agent && bun run typecheck:agent                            # installeert eerst agent/
bun run test:sandbox && bun run typecheck:sandbox
bun run test:builder-app && bun run typecheck:builder-app                # na `bun run test:agent`
(cd builder/build-service && python3 -m unittest)                        # buildservice
```

`test:builder-app` importeert code uit `agent/` en faalt met `ERR_MODULE_NOT_FOUND` zolang
`cd agent && bun install` niet is gedraaid. De uitkomsten per onderdeel en wat niet is uitgevoerd
staan in `docs/verification.md`.

## Documentatie

**Het dashboard**

- `docs/architecture.md`: huidige request- en dataarchitectuur
- `docs/verification.md`: uitgevoerde controles, tekortkomingen en open risico's
- `docs/accounts.md`: eigen accounts voor monteurs, door een admin aangemaakt (in aanbouw: kern klaar)
- `docs/proefrun-resultaten.md`: wat de agent op het dashboard deed en wat ik daarvan overnam
- `RULES.md`: de projectregels die de agent bij elke opdracht leest

**Het builder-platform** (externe aanpak, zie `docs/extern-platform-plan.md`)

- `docs/extern-platform-plan.md`: plan en fasering van het eigen builder-platform
- `docs/odoo-gateway.md`: Odoo-gateway met allowlist per project (fase 1)
- `docs/odoo-direct-client.md`: de alleen-lezen Odoo-client onder de gateway
- `docs/dig-builder-agent.md`: agent-loop die een app aanpast en het resultaat als branch en diff oplevert (fase 2)
- `docs/dig-builder-sandbox.md`: sandbox-containers, previews achter login en publiceren (fase 3)
- `docs/builder-app.md`: het scherm om opdrachten te geven en wijzigingen goed te keuren (fase 4)
- `docs/dig-builder-deploy.md`: installatie op de Hostinger-VPS (gateway, previews, TLS)
- `docs/proefrun.md`: een echte run van de agent op het dashboard (`scripts/proefrun.sh`)

**Odoo-module-variant** (alleen een skelet, niet in een echte Odoo geïnstalleerd)

- `docs/dig-builder-design.md`: ontwerp voor een beheerdersgerichte Odoo-module
- `docs/dig-builder-phase2.md`: wat er van die variant is gebouwd (buildservice en addon)

**Achtergrond en historie**

- `docs/helloleo-dependencies.md`: HelloLeo-koppelingen en hoe ze zijn vervangen
- `docs/helloleo-onderzoek.md`: onderzoek naar hoe HelloLeo werkt
- `docs/build-workflow.md`: hoe het dashboard oorspronkelijk op HelloLeo is gebouwd (historisch)

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

## Buildservice en Odoo-addon (fase 2)

Dit is de Odoo-module-variant uit `docs/dig-builder-design.md`; het platform dat je in de praktijk gebruikt
(agent, sandbox, builder-app) staat hierboven. Het root-bestand `docker-compose.yml` start alleen deze
services; de stack voor de VPS staat in `deploy/docker-compose.yml`.

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

Deze controle is geschreven maar nog niet uitgevoerd: daarvoor zijn Docker en Odoo 20 nodig
(`docs/verification.md`). De hoofdstack en bestaande databases worden
door dit script niet gebruikt. De uitvoermap wordt na afloop afgedrukt en bevat
de testuitvoer, containerlogs, Compose-status en exitstatus.
