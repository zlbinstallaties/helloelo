# Odoo-gateway (fase 1)

De gateway is de enige plek die de Odoo-API-key kent. Gegenereerde apps praten met de
gateway via een eigen projecttoken en krijgen alleen wat hun project toestaat.
Hij bouwt voort op `src/lib/odoo-client.ts` en heeft geen npm-dependencies (Node 22+).

De gateway **leest**. Er is één benoemde actie die schrijft en die voor elk project **uit** staat: een monteur als
`hr.employee` aanmaken, zonder Odoo-gebruiker (zie "Acties"). Een algemene schrijfroute is er niet.

## Endpoints

| Methode | Pad | Doel |
|---|---|---|
| `GET` | `/healthz` | Health check, zonder token |
| `GET` | `/v1/schema` | Toegestane modellen, methoden en velden met type, label en relatie (via `fields_get`) |
| `POST` | `/v1/models/<model>/search_read` | `{fields?, domain?, limit?, offset?, order?}` → `{records, count, limit, offset}` |
| `POST` | `/v1/models/<model>/search_count` | `{domain?}` → `{count}` |
| `POST` | `/v1/actions/create_employee` | `{requestId, name}` → `{id, name, verified}`; alleen voor projecten met de actie (zie "Acties") |

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

## Acties

Een project kan een vaste, benoemde actie krijgen. Zonder `actions` in de config kan het project er geen:

```json
"actions": { "createEmployee": { "responsibleUserId": <id van een Odoo-gebruiker>, "maxPerHour": 20 } }
```

**`create_employee`** maakt één `hr.employee` aan voor een monteur, **zonder Odoo-gebruiker**. Het verzoek bevat alleen
`requestId` (16 tot 64 letters, cijfers, `-` of `_`) en `name` (1 tot 80 tekens, geen stuurtekens); elke andere
parameter geeft `400 unknown_parameter`. Alles anders staat vast in de gateway:

- `company_id` is het bedrijf van het project; `hr_responsible_id` is `responsibleUserId` uit de config;
  `user_id` is altijd `false`; `date_version` is de datum van vandaag in Amsterdam. Er is geen veld waarmee een
  verzoek hier iets aan verandert, en geen ander model of andere methode.
- Bij elke aanvraag controleert de gateway dat de verantwoordelijke bestaat, actief is, een interne gebruiker is
  (geen portaal) en bij het bedrijf hoort; anders `409 responsible_not_allowed` en wordt er niets aangemaakt.
- Daarna leest de gateway de medewerker terug: heeft die toch een Odoo-gebruiker of staat hij in een ander bedrijf,
  dan `500 employee_invariant_violated` met het nummer. Lukt het terugkijken niet, dan is het antwoord
  `verified: false`.
- Een project kan maximaal `maxPerHour` (standaard 20, hoogstens 200) medewerkers per uur laten aanmaken (`429`).

Herhalingen: dezelfde `requestId` met dezelfde naam geeft hetzelfde antwoord met `replayed: true` zonder Odoo te
vragen; tegelijk lopende herhaling `409 in_progress`; een andere naam `409 request_id_reused`. Antwoordde Odoo met een
fout, dan is er niets aangemaakt en mag dezelfde aanvraag opnieuw (`502 odoo_rejected`). Is er **geen bruikbaar
antwoord** (time-out, netwerk), dan blijft de `requestId` geblokkeerd (`504`/`409 outcome_unknown`): de medewerker
kan bestaan en wordt niet nog eens aangemaakt. Dit geheugen zit in het proces (24 uur); na een herstart is het weg.

Geef de actie aan een **eigen project en token** voor het live dashboard, nooit aan het project van een preview of
de agent: elke code die dat token heeft, kan er medewerkers mee aanmaken. De voorbeeldconfig heeft geen acties en
geen verzonnen gebruikers-id.

Wat niet is geprobeerd: een aanroep tegen een echte Odoo. De vorm van de aanroep (`create` met `vals_list`) en de
velden `date_version`, `hr_responsible_id`, `share` en `company_ids` zijn alleen met nagebootste antwoorden getest.

## Veiligheidsregels

- Doelserver: de gateway start alleen als de host van `ODOO_BASE_URL` in `ODOO_ALLOWED_HOSTS`
  staat (de Odoo-**testserver**), en weigert hosts onder `*.odoo.sh` en `*.odoo.com` altijd, zodat
  de productie-Odoo niet bereikt kan worden.

- Modellen zijn alleen-lezen: alleen `search_read` en `search_count` zijn configureerbaar. Andere methoden
  (`write`, `create`, `unlink`, `execute_kw`, ...) worden al bij het laden geweigerd. De enige uitzondering is de
  benoemde actie hierboven, die niet via de modellen loopt en alleen wat daar staat kan.
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

- 50 gateway-tests en 21 clienttests geslaagd (2026-10-06), waaronder de actie; `tsc -p gateway` zonder fouten.
- End-to-end rooktest van `main.ts` tegen een lokale nep-Odoo (JSON-2) geslaagd (eerdere sessie).
- Niet uitgevoerd: Docker-image bouwen (geen Docker-daemon in de ontwikkelomgeving) en een
  aanroep tegen de echte Odoo 20-testserver.

## Gebruikt door

- Het dashboard (`src/lib/gateway.server.ts`) leest hier `planning.slot` en `svs.tech.visit`.
  De projectconfiguratie ervoor staat in `gateway/projects.example.json`.
- De agent gebruikt `/v1/schema` als `odoo_schema`-tool (`docs/dig-builder-agent.md`).
