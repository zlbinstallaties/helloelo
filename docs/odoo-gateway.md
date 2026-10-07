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
| `GET` | `/v1/planning-roles` | `{roles: [{id, name}]}`: de planningsrollen die een planner een nieuwe monteur kan geven; alleen voor projecten met de actie |
| `POST` | `/v1/actions/create_employee` | `{requestId, name, planningRoleIds?}` → `{id, name, verified, planningRoles}`; alleen voor projecten met de actie (zie "Acties") |
| `POST` | `/v1/actions/add_employee_unavailability` | `{requestId, employeeId, from, to, note?}` → `{id, employeeId, from, to, verified}`; alleen voor projecten met `employeeUnavailability` |
| `POST` | `/v1/actions/remove_employee_unavailability` | `{employeeId, leaveId}` → `{leaveId, removed}`; alleen voor projecten met `employeeUnavailability` |

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

Optioneel: `"allowedPlanningRoleIds": [<id van planning.role>, ...]` beperkt de rollen die een planner mag kiezen (1 tot 50
verschillende nummers). Zonder deze lijst mag elke bestaande, niet-gearchiveerde planningsrol.

**`create_employee`** maakt één `hr.employee` aan voor een monteur, **zonder Odoo-gebruiker**. Het verzoek bevat
`requestId` (16 tot 64 letters, cijfers, `-` of `_`), `name` (1 tot 80 tekens, geen stuurtekens) en eventueel
`planningRoleIds` (hoogstens 5 verschillende nummers van `planning.role`, in de volgorde van de keuze; anders
`400 invalid_planning_roles`); elke andere parameter geeft `400 unknown_parameter`. Alles anders staat vast in de gateway:

- `company_id` is het bedrijf van het project; `hr_responsible_id` is `responsibleUserId` uit de config;
  `user_id` is altijd `false`; `date_version` is de datum van vandaag in Amsterdam. Alleen als het verzoek rollen heeft
  komen er `planning_role_ids` (Odoo-opdracht `[[6, 0, [id's]]]`) en `default_planning_role_id` (de eerste gekozen rol) bij. Er is geen veld waarmee een
  verzoek hier iets aan verandert, en geen ander model of andere methode.
- Bij elke aanvraag controleert de gateway dat de verantwoordelijke bestaat, actief is, een interne gebruiker is
  (geen portaal) en bij het bedrijf hoort; anders `409 responsible_not_allowed` en wordt er niets aangemaakt.
- Heeft het verzoek rollen, dan controleert de gateway dat ze bij het project zijn toegestaan (als er een lijst is) en dat ze
  in Odoo bestaan en niet zijn gearchiveerd (`planning.role`); anders `409 planning_role_not_allowed` en wordt er niets
  aangemaakt.
- Daarna leest de gateway de medewerker terug: heeft die toch een Odoo-gebruiker of staat hij in een ander bedrijf,
  dan `500 employee_invariant_violated` met het nummer. Lukt het terugkijken niet, dan is het antwoord
  `verified: false`. `planningRoles` in het antwoord is het aantal gekozen rollen dat Odoo bij het terugkijken bevestigt
  (0 als er geen zijn gekozen, of als het terugkijken niet lukte of een rol niet liet zien).
- Een project kan maximaal `maxPerHour` (standaard 20, hoogstens 200) medewerkers per uur laten aanmaken (`429`).

Herhalingen: dezelfde `requestId` met dezelfde naam geeft hetzelfde antwoord met `replayed: true` zonder Odoo te
vragen; tegelijk lopende herhaling `409 in_progress`; een andere naam of andere rollen (ook in een andere volgorde) `409 request_id_reused`. Antwoordde Odoo met een
fout, dan is er niets aangemaakt en mag dezelfde aanvraag opnieuw (`502 odoo_rejected`). Is er **geen bruikbaar
antwoord** (time-out, netwerk), dan blijft de `requestId` geblokkeerd (`504`/`409 outcome_unknown`): de medewerker
kan bestaan en wordt niet nog eens aangemaakt. Dit geheugen zit in het proces (24 uur); na een herstart is het weg.

**`set_employee_planning_roles`** (aparte instelling `setEmployeePlanningRoles`, **uit tenzij je haar aanzet**; het dashboard gebruikt haar
voor de knop *Planningsrollen* bij Accounts, alleen voor medewerkers waar een monteuraccount aan hangt) zet de planningsrollen van **één bestaande** medewerker: `POST /v1/actions/set_employee_planning_roles` met
`{employeeId, planningRoleIds}` (de eerste rol wordt de standaardrol; een lege lijst haalt de rollen weg) en `GET
/v1/employees/<id>/planning-roles` om te lezen wat hij nu heeft. Meer kan het verzoek niet sturen (andere namen: `400`), de
rollen moeten bestaan en niet gearchiveerd zijn (en bij een beperking toegestaan), de medewerker moet bestaan en actief zijn in
het bedrijf van het project (`404 employee_not_found`), en er geldt een eigen limiet per uur. Dezelfde rollen nog eens zetten
geeft dezelfde medewerker, dus er is geen aanvraag-id en na een onduidelijk antwoord (`504`) mag je gewoon herhalen. Nog niet
tegen een echte Odoo geprobeerd (`write` op `hr.employee` met alleen `planning_role_ids` en `default_planning_role_id`).

**`add_employee_unavailability` en `remove_employee_unavailability`** (aparte instelling `employeeUnavailability`, **uit tenzij je haar aanzet**, met
alleen `maxPerHour`; standaard 100 per uur voor het hele project, optellend voor toevoegen en verwijderen) zetten één monteur als niet
beschikbaar in Odoo. Toevoegen maakt **één** `resource.calendar.leaves` aan voor de resource van die ene medewerker (`{name, resource_id,
calendar_id, date_from, date_to}`, verder niets): geen dienst, geen planning, geen verlofaanvraag. `from` en `to` zijn hele kalenderdagen
(beide inbegrepen, hoogstens 366 dagen) in de **tijdzone van de medewerker** zoals Odoo die heeft (onbekend: `409
employee_timezone_unknown`, er wordt niet geraden); dat wordt 00:00:00 tot 23:59:59 lokaal, als UTC aan Odoo gegeven, ook rond het verzetten
van de klok. De naam begint met `[Dashboard] Niet beschikbaar` (met de opmerking erachter), en daaraan herkent verwijderen zijn eigen
records. De medewerker moet bestaan, actief zijn en in het bedrijf van het project staan (`404 employee_not_found`) en een resource hebben
(`409 employee_has_no_resource`). Herhalen werkt als bij `create_employee`: dezelfde `requestId` met dezelfde gegevens geeft hetzelfde
record zonder opnieuw te schrijven, andere gegevens `409 request_id_reused`, tegelijk lopend `409 in_progress`, geen bruikbaar antwoord
`504`/`409 outcome_unknown` (het record kan bestaan: niet opnieuw proberen), en alleen een echte weigering van Odoo (`502 odoo_rejected`)
mag opnieuw. **Verwijderen haalt alleen een record weg dat van die medewerker is én met de herkenning begint**: een vakantiedag van het
bedrijf, een record dat iemand met de hand maakte of het record van een ander geeft `404 unavailability_not_found` en er wordt niets
verwijderd; een record dat er niet meer is, is `200` met `alreadyGone`. Nog niet tegen een echte Odoo geprobeerd.

Geef de actie aan een **eigen project en token** voor het live dashboard, nooit aan het project van een preview of
de agent: elke code die dat token heeft, kan er medewerkers mee aanmaken. De voorbeeldconfig heeft geen acties en
geen verzonnen gebruikers-id.

De Odoo-gebruiker achter `ODOO_API_KEY` moet voor deze actie HR-medewerker zijn (`hr.group_hr_user`); geef de actie
daarom aan een eigen gateway met een eigen sleutel. Zie `docs/accounts.md`, "Wat Odoo 20 er zelf bij doet", voor wat Odoo
bij het aanmaken zelf toevoegt (werkcontact, interne notitie, geen gebruiker).

Geprobeerd op een lokale Odoo 20 Enterprise met `admin` (zie `docs/verification.md`, "Eerste keer tegen een echte Odoo 20"):
Odoo nam de aanroep (`/json/2/hr.employee/create` met `vals_list`, `hr_responsible_id` en `date_version` in de waarden van de
medewerker) aan. Niet geprobeerd tegen een echte Odoo: de rollen (`planning_role_ids`, `default_planning_role_id`, en het
lezen van `planning.role`; alleen met nagebootste antwoorden getest), de testserver, productie en een gebruiker met alleen
Medewerkers: Officer. Het teruglezen
is streng: alleen `user_id: false` telt als "geen Odoo-gebruiker".

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

- 50 gateway-tests en 23 clienttests geslaagd (2026-10-06), waaronder de actie; `tsc -p gateway` zonder fouten.
- End-to-end rooktest van `main.ts` tegen een lokale nep-Odoo (JSON-2) geslaagd (eerdere sessie).
- Niet uitgevoerd: Docker-image bouwen (geen Docker-daemon in de ontwikkelomgeving) en een
  aanroep tegen de Odoo 20-testserver. Wel uitgevoerd: een lokale Odoo 20 Enterprise (zie hierboven).
- `/v1/schema` meldt een model dat de database niet heeft (bijvoorbeeld `svs.tech.visit` zonder jullie module) met
  `unknownModel: true` en laat de andere modellen gewoon zien.

## Gebruikt door

- Het dashboard (`src/lib/gateway.server.ts`) leest hier `planning.slot` en `svs.tech.visit`.
  De projectconfiguratie ervoor staat in `gateway/projects.example.json`.
- De agent gebruikt `/v1/schema` als `odoo_schema`-tool (`docs/dig-builder-agent.md`).
