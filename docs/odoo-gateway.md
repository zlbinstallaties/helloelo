# Odoo-gateway (fase 1)

De gateway is de enige plek die de Odoo-API-key kent. Gegenereerde apps praten met de
gateway via een eigen projecttoken en krijgen alleen wat hun project toestaat.
Hij bouwt voort op `src/lib/odoo-client.ts` en heeft geen npm-dependencies (Node 22+).

## Endpoints

| Methode | Pad | Doel |
|---|---|---|
| `GET` | `/healthz` | Health check, zonder token |
| `GET` | `/v1/schema` | Toegestane modellen, methoden en velden met type, label en relatie (via `fields_get`) |
| `POST` | `/v1/models/<model>/search_read` | `{fields?, domain?, limit?, offset?, order?}` → `{records, count, limit, offset}` |
| `POST` | `/v1/models/<model>/search_count` | `{domain?}` → `{count}` |

Elke `/v1`-aanroep vereist `Authorization: Bearer <projecttoken>`.

`/v1/schema` meldt per model ook `missing`: velden die wel in de allowlist staan maar
niet in deze Odoo-database bestaan. Zo zie je meteen of veldnamen kloppen voor Odoo 20.
Het schema wordt per model 5 minuten in het geheugen bewaard.

## Projectconfiguratie

Kopieer `gateway/projects.example.json` naar `gateway/projects.json` (staat in `.gitignore`).

```json
{
  "projects": [{
    "id": "monteursdashboard",
    "tokenSha256": "<sha256 van het token>",
    "companyId": 2,
    "maxLimit": 500,
    "models": {
      "planning.slot": { "methods": ["search_read", "search_count"], "fields": ["name", "state"] }
    }
  }]
}
```

Een token maak je met `bun run gateway:token`. Het token gaat als serversecret naar de app;
alleen de hash komt in de config. `id` is altijd toegestaan.

## Veiligheidsregels

- Alleen-lezen: alleen `search_read` en `search_count` zijn configureerbaar. Andere methoden
  (`write`, `create`, `unlink`, `execute_kw`, ...) worden al bij het laden geweigerd.
- Bedrijf komt uit de projectconfig en wordt aan zowel het domain als de context toegevoegd.
  De request kan geen `companyId` of `context` meesturen (onbekende parameters → 400).
- Velden in `fields`, `domain` en `order` moeten in de allowlist staan; geen punt-paden
  (`partner_id.name`), dus geen sprong naar andere modellen.
- Domain-operators: vergelijkingen, `in`/`not in` en `like`-varianten. Geen `child_of`,
  `parent_of` of `any`. Waarden zijn primitieven of korte lijsten.
- Het domain moet uit volledige expressies bestaan, zodat het bedrijfsfilter altijd met het
  hele domain wordt ge-AND-ed (`['|', A]` wordt geweigerd).
- `limit` is maximaal `maxLimit` van het project (hard maximum 1000); body maximaal 64 KB.
- Tokens worden als sha256-hash vergeleken in constante tijd.
- Odoo-foutmeldingen kunnen recorddata bevatten; de gateway geeft alleen de foutklasse door
  (`502 odoo_error`) of `504 odoo_timeout`.
- Toegangslog: één JSON-regel per aanroep op stdout met project, route, model, status,
  duur, aantal rijen/velden en de *namen* van domain-velden. Nooit tokens of waarden.

Bekende beperking: many2one-velden geven `[id, display_name]` terug, ook als het
gerelateerde model niet in de allowlist staat. Neem zulke velden alleen op als die naam
voor de app zichtbaar mag zijn. De Odoo-gebruiker achter `ODOO_API_KEY` blijft de laatste
grens: geef die alleen leesrechten op de benodigde modellen en het testbedrijf.

## Draaien

```bash
bun run test:gateway        # tests met nep-Odoo, geen netwerk nodig
bun run typecheck:gateway
ODOO_BASE_URL=... ODOO_API_KEY=... GATEWAY_PROJECTS_FILE=gateway/projects.json \
  node --experimental-strip-types gateway/src/main.ts
docker compose up --build odoo-gateway
```

In Compose heeft de gateway geen gepubliceerde host-poort; apps bereiken hem intern op
`http://odoo-gateway:8070`.

## Verificatie

- 19 gateway-tests en 11 clienttests geslaagd; `tsc -p gateway` en oxlint zonder meldingen.
- End-to-end rooktest van `main.ts` tegen een lokale nep-Odoo (JSON-2) geslaagd.
- Niet uitgevoerd: Docker-image bouwen (geen Docker-daemon in de ontwikkelomgeving) en een
  aanroep tegen de echte Odoo 20-testserver.

## Volgende stappen

- Dashboard (`src/lib/cache.ts`) via de gateway laten lezen in plaats van direct of via HelloLeo.
- Fase 2: de agent-service gebruikt `/v1/schema` als `odoo_schema`-tool.
