# Verificatie en beperkingen

Bijgewerkt op 2026-10-06. Alles onder "Zelf uitgevoerd" is op die datum gedraaid in een
Linux-container zonder Docker-daemon en zonder echte Odoo. Wat daar niet onder valt, staat
expliciet als "niet uitgevoerd" of als historisch.

## Zelf uitgevoerd (2026-10-06)

| Onderdeel | Controle | Uitkomst |
|---|---|---|
| Dashboard | `bun run typecheck`, `bun run lint`, `bun run build` | geslaagd, geen meldingen |
| Dashboard | `bun run test:app` | 37 van 37 geslaagd (`test/appointments.test.ts`, `test/dashboard-client.test.ts`, `test/ttl-cache.test.ts`) |
| Odoo-client | `bun run test:odoo` | 11 van 11 geslaagd |
| Gateway | `bun run test:gateway`, `bun run typecheck:gateway` | 23 van 23 geslaagd, typecheck zonder fouten |
| Sandbox | `bun run test:sandbox`, `bun run typecheck:sandbox` | 39 geslaagd, 3 overgeslagen: de Docker-integratietests slaan zichzelf over zonder daemon |
| Agent | `bun run test:agent`, `bun run typecheck:agent` | 37 van 37 geslaagd, typecheck zonder fouten |
| Builder-app | `bun run test:builder-app`, `bun run typecheck:builder-app` | 54 van 54 geslaagd, typecheck zonder fouten. De afhankelijkheden van `agent/` moeten eerst geïnstalleerd zijn (`cd agent && bun install`), anders falen deze tests met `ERR_MODULE_NOT_FOUND` voor `@anthropic-ai/sdk`. |
| Buildservice (Python) | `python3 -m unittest` in `builder/build-service` | 15 van 15 geslaagd |

## Niet uitgevoerd

- Alles tegen de echte Odoo 20-testserver: gateway en dashboard zijn alleen met een nagebootste Odoo
  getest.
- De Odoo-addon `builder/odoo_addon/dig_builder` (installatie en `tests/`): er is geen Odoo of Docker
  beschikbaar. `scripts/run-dig-builder-integration.sh` is geschreven maar niet gedraaid. De laatste
  bekende installatiepoging faalde op `Invalid field 'group_ids' in 'ir.actions.client'`; dat veld
  staat nu alleen nog op de `ir.actions.act_window` `action_dig_builder_project`, maar de herstelde
  installatie is niet opnieuw uitgevoerd.
- De Docker-integratietests van de sandbox en het publiceren met een echte daemon. Eerdere sessies
  meldden die als geslaagd (`docs/dig-builder-sandbox.md`); vandaag niet herhaald.
- Een run met de echte Claude API vanuit de builder-app (de proefruns zijn wel gedraaid, zie
  `docs/proefrun-resultaten.md`).
- Echte OpenAI- of Anthropic-aanroepen vanuit de buildservice: de providercode is alleen met
  nagebootste antwoorden getest.

## Dashboard: stand van zaken

| Controle | Status | Bevinding |
|---|---|---|
| Alleen-lezen Odoo-methoden | Geslaagd | Het dashboard roept alleen `search_read` aan via `src/lib/gateway.server.ts`. De gateway staat alleen `search_read` en `search_count` toe en weigert andere methoden al bij het laden van de projectconfig. |
| Geen berichten, geen configuratiewijzigingen | Geslaagd voor huidige code | Geen mail-, chatter- of notificatiecall en geen schrijfactie in dashboardcode. |
| Bedrijfsafscherming | Geslaagd, bij de gateway | `company_id = 2` komt uit de projectconfig van de gateway en wordt aan domain en context toegevoegd; de browser kan dat niet meesturen. `TEST_COMPANY_ID` in `src/lib/cache.ts` is alleen voor weergave. Dit vervangt geen gebruikersauthenticatie. |
| Authenticatie van het dashboard zelf | Open | De app heeft geen login. Toegang loopt via de preview-proxy van `sandbox/` met één gedeeld wachtwoord. Zie ook "Aanbevolen vervolgreparaties". |
| Geheimen in browsercode | Geslaagd op code-inspectie | `DIG_GATEWAY_TOKEN` staat alleen in `src/lib/gateway.server.ts`, dat een server-only import heeft. Alleen `.env.example` staat in git; `.env` en `.env.*` zijn uitgesloten. |
| Meerdere bezoeken per afspraak | Geslaagd | Opgelost via proefrun 1 en 2 (`docs/proefrun-resultaten.md`). Een afspraak toont alle bezoeken; de status is die van het eerste bezoek dat nog niet is afgerond. Een test op 3000 willekeurige datasets bewaakt dat elk bezoek precies één keer op het scherm staat. |
| Bezoek met niet-geladen planning | Geslaagd | Zo'n bezoek valt terug op een geladen planning die het bezoek opsomt, en blijft anders als "Niet gepland" zichtbaar. |
| Monteursfilter | Geslaagd in tests, niet met echte Odoo-data | De filter werkt op een stabiele sleutel per persoon: `employee:<id>`, `user:<id>` of, alleen als Odoo geen id meegeeft, `name:<naam>` (`DashboardPerson` in `src/lib/dashboard-types.ts`). Twee monteurs met dezelfde naam zijn twee keuzes in de lijst, met hun Odoo-id erachter (`Piet Smit (medewerker 7)`); alleen bij gelijke namen komt dat achtervoegsel erbij. Een gebruiker en een medewerker die in één afspraak onder dezelfde naam staan, gelden als één persoon (`userAliases` in `src/lib/appointments.ts`): er is geen andere koppeling, want het dashboard leest geen `hr.employee` of `res.users`. Is dat bewijs dubbelzinnig (meerdere mensen met die naam in de afspraak, of dezelfde gebruiker bij verschillende medewerkers), dan wordt er niet gekoppeld. Een persoon die alleen als gebruiker én alleen als medewerker voorkomt, zonder ooit samen in één afspraak te staan, verschijnt dus twee keer. Daarnaast aangenomen: `technician_id` is een `res.users`-record (zo staat het in `scripts/demo-data.mjs`). Niet bewezen is hoe Odoo de many2many-velden `employee_ids` en `user_ids` echt aanlevert (de demodata en de typen gaan uit van `[id, naam]`-paren, en een echte toegewezen many2many is nooit gezien); komen er alleen id's binnen, dan toont het dashboard `Medewerker 4` of `Gebruiker 4`. Gedekt door 7 tests; de logica is met vijf opzettelijke fouten gecontroleerd (filter op naam, geen koppeling gebruiker-medewerker, dubbelzinnigheid en conflict tussen afspraken negeren, achtervoegsel altijd) en alle vijf werden door een test gevonden. Ook bekeken met `scripts/probe.mjs` en in Chromium tegen de demodata (twee Piet Smits, elk met alleen de eigen afspraak). |
| Tijdzone en periodefilter | Geslaagd | Weergave en alle drie de periodefilters gebruiken de Amsterdamse datum (`visitDate`, via `amsterdamDate`). Een eerdere fout in `upcoming` (UTC-starttijd vergeleken met een Amsterdamse datum, waardoor een afspraak van 6 oktober 01:00 wel onder "Vandaag" maar niet onder "Komend" viel) is op 2026-10-06 opgelost. Twee tests bewaken dit: het geval net na middernacht in zomer- en wintertijd, en een controle over een halfuursraster rond beide klokwisselingen dat alles onder "Vandaag" ook onder "Komend" staat. Beide tests faalden op de oude code. |
| Odoo-limiet 500 | Bekende beperking | Beide reads gebruiken `limit: 500` zonder paginering. De gateway begrenst met `maxLimit` van het project (hard maximum 1000). Onvoldoende voor grotere omgevingen. |
| Odoo-foutafhandeling | Geslaagd | Een `GatewayError` wordt 503 (gateway niet ingesteld) of 502; de pagina toont een foutstaat. De vernieuwknop (`useMutation` in `src/routes/index.tsx`, met `src/lib/dashboard-client.ts`) gebruikt het antwoord van haar eigen `POST` rechtstreeks, zonder tweede leesactie erachter, en blokkeert tijdens het vernieuwen. Mislukt het vernieuwen (storing, onbereikbare server, onbruikbaar antwoord), dan blijven de getoonde gegevens staan en meldt een toast de reden en hoe oud de gegevens zijn. Gecontroleerd in Chromium met een nep-gateway die uitvalt en terugkomt: één `POST` per klik en geen `GET` erachter; bij een storing één aanroep naar de gateway (de eerste leesactie faalt). Let op: `refresh()` gooit de servercache weg, dus na een mislukte vernieuwing leest het volgende `GET` opnieuw uit Odoo en toont de pagina een foutstaat als Odoo dan nog steeds niet antwoordt (zo bedoeld, getest in `test/ttl-cache.test.ts`). De 20 s time-out van de gateway-client blijft per leesactie gelden. |
| Lege toestand | Geslaagd | Een selectie zonder resultaat toont een lege toestand met knoppen voor "komend" en "alle". |
| Zelfstandige draai | Eerder geslaagd, niet herhaald | Dashboard zonder HelloLeo of Cloudflare, tegen een nagebootste Odoo via de gateway, op Node en als preview in de sandbox. Niet getest tegen de echte Odoo 20-testserver. |

## Builder en buildservice: stand van zaken

| Controle | Status | Bevinding |
|---|---|---|
| Agent, sandbox, builder-app, gateway | Geslaagd in unit- en integratietests | Zie "Zelf uitgevoerd". Docker-afhankelijke tests zijn hier overgeslagen. |
| Provider-extractie (OpenAI/Anthropic) | Geslaagd met nagebootste antwoorden | `builder/build-service/test_providers.py`: geneste `output_text`, meerdere blokken, lege of afgebroken antwoorden, providerfouten, begrensde uitvoer. |
| Buildservice | Geslaagd met nagebootste provider | `test_service.py`: tokencontrole, geen providergeheimen in de store, idempotente taken, scheiding per project en bedrijf, herstart als "onbekend" in plaats van opnieuw proberen, metadata in de prompt. |
| Metadata-contract `odoo20-v1` | Code aanwezig, Odoo-kant niet uitgevoerd | De buildservice valideert het contract; de Odoo-kant (allowlist, `fields_get()` zonder `sudo()`) is niet in een echte Odoo gedraaid. |
| Beschermde workflowvelden | Code aanwezig, niet uitgevoerd | `create`, `write` en `copy` weigeren directe state-, phase-, proposal-, metadata-, hash- en servicevelden; alleen private workflowmethoden schrijven ze. Test in `tests/test_security.py`, niet gedraaid. |
| Odoo 20-veldcompatibiliteit | Eerder gecontroleerd via MCP-schema | `res.groups.privilege_id`, `res.users.group_ids`, `res.users.all_group_ids`, `has_access("read")`, model `ir.access` en `ir.config_parameter.get_str()`/`set_str()` bestonden. Niet opnieuw gecontroleerd. |
| Authenticatie van de Odoo-addon | Code aanwezig, integratietest niet uitgevoerd | Routes zijn `auth="user"` en controleren per aanroep `dig_builder.group_dig_builder_admin`. De regressietests voor niet-ingelogd, niet-beheerder en rechtstreeks openen van de client action zijn niet tegen een echte Odoo gedraaid. |
| Authenticatie van de builder-app | Tijdelijk | Eén gedeeld wachtwoord (scrypt-hash), HMAC-sessiecookie, CSRF-bescherming, snelheidslimiet per IP. Login via Odoo-gebruikers is de volgende stap (`docs/builder-app.md`). |

## Historische controles (HelloLeo-tijdperk)

Deze controles zijn gedaan toen het dashboard nog op het HelloLeo-platform draaide (2026-10-04). De
code waar ze over gingen (`HELLOLEO_API_KEY`, de HelloLeo-preview en -tools) bestaat niet meer; ze
zijn hier bewaard als achtergrond, niet als bewijs voor de huidige code.

- De preview-API gaf `TV/0001` terug met status `in_progress`, één ontbrekend verplicht onderdeel en
  nul foto's.
- Hoofdpagina, `/api/dashboard` en de POST-refresh antwoordden met HTTP 200 op de HelloLeo-preview.
- In de HelloLeo-previewlogs stond geen backend-runtimefout; wel een oude HMR-CSS-melding en een
  React-keywaarschuwing.
- Het lokale `.env` bevatte toen een `HELLOLEO_API_KEY`. Die waarde is niet in documentatie of nieuwe
  bestanden gekopieerd en het bestand wordt door `.gitignore` uitgesloten.

## Aanbevolen vervolgreparaties

Opgelost sinds de vorige versie van dit document: meerdere bezoeken per afspraak, unit tests voor
mapping en multi-visit, een expliciete tijdzone-helper met tests rond de klokwisselingen, het filter
`upcoming` rond middernacht Amsterdamse tijd, de monteursfilter op een stabiel id en de foutafhandeling
van de vernieuwknop.

1. Voeg echte server-side app-authenticatie en rollen toe voordat het dashboard buiten de
   DIG Builder-preview wordt gebruikt.
2. Voeg server-side paginering of een datumgebonden Odoo-domain toe vóór datasets boven 500 records.
3. Voer de Odoo-addon-installatie en `scripts/run-dig-builder-integration.sh` uit op een omgeving met
   Docker en Odoo 20, en een run met de echte Odoo 20-testserver achter de gateway. Controleer daarbij
   ook hoe `employee_ids`, `user_ids` en `technician_id` er in het echte antwoord uitzien en of de
   koppeling tussen gebruiker en medewerker op naam daar volstaat.
