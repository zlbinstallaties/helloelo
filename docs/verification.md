# Verificatie en beperkingen

Bijgewerkt op 2026-10-06. Alles onder "Zelf uitgevoerd" is op die datum gedraaid in een
Linux-container zonder Docker-daemon en zonder echte Odoo. Wat daar niet onder valt, staat
expliciet als "niet uitgevoerd" of als historisch.

## Zelf uitgevoerd (2026-10-06)

| Onderdeel | Controle | Uitkomst |
|---|---|---|
| Dashboard | `bun run typecheck`, `bun run lint`, `bun run build` | geslaagd, geen meldingen |
| Dashboard | `bun run test:app` | 247 van 247 geslaagd (afspraken, paginering, cache, dashboard-client; accounts, wachtwoorden, sessies, bevoegdheden, handlers; monteur toevoegen: journaal, service, gateway-koppeling en de hele keten) |
| Odoo-client | `bun run test:odoo` | 21 van 21 geslaagd, waarvan 10 voor de aanmaakactie |
| Gateway | `bun run test:gateway`, `bun run typecheck:gateway` | 50 van 50 geslaagd (waarvan 27 voor de actie en de configuratie ervan), typecheck zonder fouten |
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
- Alles wat de aanmaak van een medewerker naar een echte Odoo stuurt: er is bewust niets echt geschreven.
- De Docker-integratietests van de sandbox en het publiceren met een echte daemon. Eerdere sessies
  meldden die als geslaagd (`docs/dig-builder-sandbox.md`); vandaag niet herhaald.
- Een run met de echte Claude API vanuit de builder-app (de proefruns zijn wel gedraaid, zie
  `docs/proefrun-resultaten.md`).
- Echte OpenAI- of Anthropic-aanroepen vanuit de buildservice: de providercode is alleen met
  nagebootste antwoorden getest.

## Dashboard: stand van zaken

| Controle | Status | Bevinding |
|---|---|---|
| Odoo-methoden | Geslaagd, met één bewuste schrijfactie | Voor de data gebruikt het dashboard alleen `search_read` via `src/lib/gateway.server.ts`; de gateway staat op modellen alleen `search_read` en `search_count` toe. De enige schrijfactie is "monteur als medewerker aanmaken" (zie "Monteur toevoegen"): een `hr.employee` zonder Odoo-gebruiker, door een planner, en standaard uit. Er is geen algemene schrijfroute, geen aanmaak van `res.users`, planning of dienst. |
| Geen berichten, geen configuratiewijzigingen | Geslaagd voor de dashboardcode, met voorbehoud bij het aanmaken | Geen mail-, chatter- of notificatiecall in dashboardcode. De aanmaak van een medewerker stuurt in de context `mail_create_nosubscribe` en `mail_auto_subscribe_no_notify` mee om volgers en mails te vermijden; dat is niet in een echte Odoo geprobeerd. Odoo 20 zelf legt bij het aanmaken van een medewerker een interne notitie in de chatter vast (een log, geen mail) en maakt een werkcontact aan (`docs/accounts.md`). |
| Bedrijfsafscherming | Geslaagd, bij de gateway | `company_id = 2` komt uit de projectconfig van de gateway en wordt aan domain en context toegevoegd; de browser kan dat niet meesturen. `TEST_COMPANY_ID` in `src/lib/cache.ts` is alleen voor weergave. Dit vervangt geen gebruikersauthenticatie. |
| Authenticatie van het dashboard zelf | Gebouwd en aangesloten, getest met mocks; **niet geschikt voor een gepubliceerd dashboard** | Accounts die een planner aanmaakt, scrypt-wachtwoorden, getekende sessies, inlogbeperking, noodaccount, bevoegdheden (een monteur ziet alleen zijn eigen afspraken, zonder Odoo-links, kan niet vernieuwen of beheren) en de header `X-Dig-Dashboard` bij elke wijziging; zonder `DIG_SESSION_SECRET` is het dashboard dicht (503), `DIG_AUTH=off` zet het bewust open. Gecontroleerd met unit-tests, met de gebouwde server over echte HTTP (25 controles) en in Chromium (26 controles voor het hoofdverhaal en 10 voor foutgevallen); die laatste drie zijn wegwerpscripts buiten de repository. Een gepubliceerd dashboard kan de accounts niet bewaren: zie `docs/accounts.md`, "Wat nog moet". |
| Monteur toevoegen (schrijfactie naar Odoo) | Getest met mocks en in Chromium; **niets tegen een echte Odoo geprobeerd** | Zie hieronder. |
| Geheimen in browsercode | Geslaagd op code-inspectie | `DIG_GATEWAY_TOKEN` staat alleen in `src/lib/gateway.server.ts`, dat een server-only import heeft. Alleen `.env.example` staat in git; `.env` en `.env.*` zijn uitgesloten. |
| Meerdere bezoeken per afspraak | Geslaagd | Opgelost via proefrun 1 en 2 (`docs/proefrun-resultaten.md`). Een afspraak toont alle bezoeken; de status is die van het eerste bezoek dat nog niet is afgerond. Een test op 3000 willekeurige datasets bewaakt dat elk bezoek precies één keer op het scherm staat. |
| Bezoek met niet-geladen planning | Geslaagd | Zo'n bezoek valt terug op een geladen planning die het bezoek opsomt, en blijft anders als "Niet gepland" zichtbaar. |
| Monteursfilter | Geslaagd in tests, niet met echte Odoo-data | De filter werkt op een stabiele sleutel per persoon: `employee:<id>`, `user:<id>` of, alleen als Odoo geen id meegeeft, `name:<naam>` (`DashboardPerson` in `src/lib/dashboard-types.ts`). Twee monteurs met dezelfde naam zijn twee keuzes in de lijst, met hun Odoo-id erachter (`Piet Smit (medewerker 7)`); alleen bij gelijke namen komt dat achtervoegsel erbij. Een gebruiker en een medewerker die in één afspraak onder dezelfde naam staan, gelden als één persoon (`userAliases` in `src/lib/appointments.ts`): er is geen andere koppeling, want het dashboard leest geen `hr.employee` of `res.users`. Is dat bewijs dubbelzinnig (meerdere mensen met die naam in de afspraak, of dezelfde gebruiker bij verschillende medewerkers), dan wordt er niet gekoppeld. Een persoon die alleen als gebruiker én alleen als medewerker voorkomt, zonder ooit samen in één afspraak te staan, verschijnt dus twee keer. Daarnaast aangenomen: `technician_id` is een `res.users`-record (zo staat het in `scripts/demo-data.mjs`). Niet bewezen is hoe Odoo de many2many-velden `employee_ids` en `user_ids` echt aanlevert (de demodata en de typen gaan uit van `[id, naam]`-paren, en een echte toegewezen many2many is nooit gezien); komen er alleen id's binnen, dan toont het dashboard `Medewerker 4` of `Gebruiker 4`. Gedekt door 7 tests; de logica is met vijf opzettelijke fouten gecontroleerd (filter op naam, geen koppeling gebruiker-medewerker, dubbelzinnigheid en conflict tussen afspraken negeren, achtervoegsel altijd) en alle vijf werden door een test gevonden. Ook bekeken met `scripts/probe.mjs` en in Chromium tegen de demodata (twee Piet Smits, elk met alleen de eigen afspraak). |
| Tijdzone en periodefilter | Geslaagd | Weergave en alle drie de periodefilters gebruiken de Amsterdamse datum (`visitDate`, via `amsterdamDate`). Een eerdere fout in `upcoming` (UTC-starttijd vergeleken met een Amsterdamse datum, waardoor een afspraak van 6 oktober 01:00 wel onder "Vandaag" maar niet onder "Komend" viel) is op 2026-10-06 opgelost. Twee tests bewaken dit: het geval net na middernacht in zomer- en wintertijd, en een controle over een halfuursraster rond beide klokwisselingen dat alles onder "Vandaag" ook onder "Komend" staat. Beide tests faalden op de oude code. |
| Paginering | Geslaagd met nagebootste Odoo, niet met echte Odoo-data | `readAllPages` (`src/lib/paging.ts`) leest een model pagina na pagina (500 per aanroep, de `maxLimit` van het gatewayproject) tot een pagina niet vol is; de gateway geeft geen totaal. Sortering `start_datetime desc, id desc` (planning) en `visit_date desc, id desc` (bezoeken): `id` geeft elk record een vaste plek, en bij het plafond vallen de oudste records weg, niet de komende. Het plafond is 5000 records per model; wordt het bereikt dan zoekt één extra aanroep van 1 record of er meer was, en meldt `truncated` in het antwoord, waarop het scherm een waarschuwing toont. Een record dat op twee pagina's opduikt wordt één keer bewaard; een mislukte pagina laat de hele lezing mislukken (geen half resultaat dat compleet lijkt). Gecontroleerd met de echte gateway-code (`gateway/src/main.ts`) tegen een nep-Odoo met 1200, 5000 en 5300 planningen: 1200 en 5000 volledig en `truncated=false`; 5300 geeft de nieuwste 5000 (id 301 tot 5300), `truncated=true`, 200 bezoeken van afgevallen planningen als "Niet gepland", en de waarschuwing in Chromium. Gedekt door 11 tests, met zeven opzettelijke fouten gecontroleerd; alle zeven werden door een test gevonden. Bekend: (1) met offset-paginering kan een record ontbreken als er tijdens het lezen records worden toegevoegd of verwijderd; de volgende vernieuwing herstelt dat. (2) Het tonen van 5200 kaarten tegelijk kostte ongeveer 8 seconden in headless Chromium in deze container; de lijst toont daarom 100 kaarten tegelijk (zie "Lange lijst in delen"). (3) Het gedrag van `order` op `start_datetime` en `visit_date` is alleen met de nagebootste Odoo bekeken. |
| Odoo-foutafhandeling | Geslaagd | Een `GatewayError` wordt 503 (gateway niet ingesteld) of 502; de pagina toont een foutstaat. De vernieuwknop (`useMutation` in `src/routes/index.tsx`, met `src/lib/dashboard-client.ts`) gebruikt het antwoord van haar eigen `POST` rechtstreeks, zonder tweede leesactie erachter, en blokkeert tijdens het vernieuwen. Mislukt het vernieuwen (storing, onbereikbare server, onbruikbaar antwoord), dan blijven de getoonde gegevens staan en meldt een toast de reden en hoe oud de gegevens zijn. Gecontroleerd in Chromium met een nep-gateway die uitvalt en terugkomt: één `POST` per klik en geen `GET` erachter; bij een storing één aanroep naar de gateway (de eerste leesactie faalt). Let op: `refresh()` gooit de servercache weg, dus na een mislukte vernieuwing leest het volgende `GET` opnieuw uit Odoo en toont de pagina een foutstaat als Odoo dan nog steeds niet antwoordt (zo bedoeld, getest in `test/ttl-cache.test.ts`). De 20 s time-out van de gateway-client blijft per leesactie gelden. |
| Lange lijst in delen | Geslaagd in Chromium, geen geautomatiseerde test | De lijst toont 100 afspraken, met onderaan "100 van 5.200 afspraken getoond" en een knop "Toon 100 meer" (`Appointments` in `src/routes/index.tsx`). Bij 100 of minder verandert er niets. De overzichtskaarten bovenaan tellen alle afspraken, niet alleen de getoonde. Wisselen van datum, periode of monteur zet de lijst terug op 100; vernieuwen houdt de stand. Met de echte keten bekeken (nep-Odoo met 80, 350 en 5300 planningen): de eerste weergave van 5200 afspraken duurde ongeveer 1,5 seconde in plaats van ongeveer 8, het detailpaneel opent ook voor kaarten die later zijn toegevoegd, en de laatste klik toont "Alle 350 afspraken getoond" zonder knop. Dit is met een wegwerpscript gecontroleerd dat niet in de repository staat; er is geen test in `test/`, omdat het component alleen uit weergave bestaat. |
| Lege toestand | Geslaagd | Een selectie zonder resultaat toont een lege toestand met knoppen voor "komend" en "alle". |
| Zelfstandige draai | Eerder geslaagd, niet herhaald | Dashboard zonder HelloLeo of Cloudflare, tegen een nagebootste Odoo via de gateway, op Node en als preview in de sandbox. Niet getest tegen de echte Odoo 20-testserver. |

## Monteur toevoegen: wat is gecontroleerd

De planner voegt een monteur toe; de gateway maakt een `hr.employee` aan zonder `user_id`; daarna komt het portaalaccount,
gekoppeld aan `employee:<nummer>`. Details en foutgevallen: `docs/accounts.md`, `docs/odoo-gateway.md`.

| Eis | Hoe gecontroleerd |
|---|---|
| Niet ingelogd of monteur: geen aanmaak | handlers: 401 en 403, en de gateway en Odoo krijgen niets te zien (`test/admin-handlers.test.ts`, `test/employee-chain.test.ts`); in Chromium als monteur 403 op alle beheerroutes |
| Alleen een planner | rol-controle in de service en in de handler, beide getest; wijzigingsverzoeken zonder `X-Dig-Dashboard` geven 403 |
| `company_id` en verantwoordelijke niet uit de browser | onbekende velden geven 400 (dashboard en gateway); de aanroep naar Odoo bevat bedrijf en verantwoordelijke uit de gatewayconfig |
| Geen `res.users`, `user_id` leeg | de client heeft geen parameter daarvoor (getest met pogingen om het te zetten); de hele keten legt elke aanroep naar de nagebootste Odoo vast: alleen `res.users` lezen, `hr.employee` aanmaken en teruglezen; de gateway meldt een medewerker met Odoo-gebruiker als fout |
| `hr_responsible_id` verplicht, geldig, van het bedrijf | de gateway controleert bij elke aanvraag: bestaat, actief, interne gebruiker (geen portaal), bedrijf; zonder configuratie staat de actie uit |
| Koppeling met een stabiel id | `personId` is `employee:<nummer van Odoo>`; twee monteurs met dezelfde naam geven twee medewerkers en twee accounts |
| Fouten van Odoo: geen succes, geen lokaal account | geweigerd, buiten gebruik, onbekende uitkomst en afwijkende medewerker: telkens een foutmelding, geen wachtwoord en geen account |
| Dubbele aanvragen | journaal op schijf (dashboard) en geheugen (gateway): herhaling geeft hetzelfde antwoord; twee klikken tegelijk één medewerker; onbekende uitkomst wordt nooit opnieuw verstuurd; ook in Chromium |
| Lijst wordt bijgewerkt | na het toevoegen staat het account in de lijst, met "Nog niet ingepland in Odoo" |
| Bestaande leesfunctionaliteit | dashboard, filters, paginering, vernieuwen en de lijst in delen zijn ongewijzigd getest |

De logica is met opzettelijke fouten gecontroleerd: 34 in de service, handlers en gateway-koppeling (vier overlevers, waarvan
twee gelijkwaardig; voor de andere twee zijn tests toegevoegd), 28 in de gateway-actie (vier overlevers, allemaal
gelijkwaardig omdat de beveiliging dubbel is uitgevoerd; elk paar tegelijk uitgeschakeld is wel gevangen) en 16 in de Odoo-client (alle gevangen).

**Gelezen in de Odoo 20.0-broncode** (`addons/hr`, `addons/rpc/controllers/json2.py`, `odoo/orm`; 2026-10-06): de aanroep
`POST /json/2/hr.employee/create` met `vals_list` en `context` bovenaan klopt met de controller; `hr_responsible_id` en
`date_version` zijn velden van `hr.version`, verplicht, en worden bij `create` uit de waarden van de medewerker gehaald;
`with_company(<nummer>)` werkt met een bedrijfsnummer; een leeg many2one is `false`, een gevuld `[id, naam]`, een many2many
een lijst nummers. Gevolg voor de code: het teruglezen is strenger gemaakt (een onleesbare `user_id` geldt als gekoppeld,
een medewerker in een ander bedrijf wordt als zodanig gemeld) en `company_ids` wordt als nummers of paren gelezen
(2 nieuwe en 2 aangepaste tests; 7 opzettelijke fouten, allemaal gevangen). Daarbij bleek dat Odoo zelf een werkcontact (`res.partner`, geen
gebruiker) en een interne notitie aanmaakt, en dat de sleutelgebruiker HR-medewerker moet zijn (`docs/accounts.md`).

**Niet bewezen:** (1) alles tegen een draaiende Odoo: rechten, toegangsregels en eigen modules van jullie database, en of de
contextsleutels volgers en meldingen helemaal voorkomen; (2) de Enterprise-module Planning, waarvan de broncode niet is
gelezen; (3) welke Odoo-gebruiker als verantwoordelijke moet gelden: die staat bewust nergens in de repository.

## Lokaal testpakket

`docs/lokaal-testen.md`, `scripts/local-setup.ts`, `scripts/demo-odoo.mjs` en de scripts `local:*`. Met echte processen
doorlopen (setup, demo-Odoo, gateway, dashboard, API en Chromium), alleen tegen de demo-Odoo en niet tegen een echte Odoo:

| Controle | Uitkomst |
|---|---|
| Setup schrijft geldige configuratie | de gateway-parser accepteert het projectbestand; de hash komt overeen met het token van het dashboard; het wachtwoord past bij de hash en staat nergens op schijf; bestanden 0600, map 0700; geen overschrijven zonder `--force` (8 tests, 12 opzettelijke fouten, allemaal gevangen) |
| Productie geweigerd | `*.odoo.sh` en `*.odoo.com` worden door de setup en de gateway geweigerd; `http` alleen voor `localhost` en `127.0.0.1` |
| Hele keten | admin logt in met het getoonde wachtwoord; één monteur geeft precies één `hr.employee`-create met `user_id: false`, bedrijf en verantwoordelijke uit de config; herhaling maakt niets nieuws; de monteur logt in en ziet alleen zijn eigen lijst; geen token of wachtwoord in de logs |
| Foutgevallen | verantwoordelijke is portaal, gedeactiveerd of bestaat niet: foutmelding, niets aangemaakt, geen account; zonder verantwoordelijke: "staat niet aan" |
| Demo-Odoo | 5 tests; volgt de Odoo 20.0-broncode voor `create` (`vals_list`, lijst met nummers), many2one en many2many, maar maakt het werkcontact en de notitie niet zelf aan (hij meldt het alleen) |

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
`upcoming` rond middernacht Amsterdamse tijd, de monteursfilter op een stabiel id, de foutafhandeling
van de vernieuwknop, paginering boven 500 records en het tonen van lange lijsten in delen.

1. Maak een gepubliceerd dashboard geschikt voor eigen accounts (blijvende opslag per project, sessiegeheim als
   omgevingsvariabele, de gedeelde proxy-login er niet vóór): `docs/accounts.md`, "Wat nog moet". Dat verandert de
   beveiligingsgrenzen van de sandbox.
2. Kies de Odoo-gebruiker die verantwoordelijke wordt (`responsibleUserId` in een eigen gatewayproject), controleer de
   aanroepen eerst met `/v1/schema` op de testserver, en probeer de aanmaak voor het eerst op de testserver.
3. Voer de Odoo-addon-installatie en `scripts/run-dig-builder-integration.sh` uit op een omgeving met
   Docker en Odoo 20, en een run met de echte Odoo 20-testserver achter de gateway. Controleer daarbij
   ook hoe `employee_ids`, `user_ids` en `technician_id` er in het echte antwoord uitzien en of de
   koppeling tussen gebruiker en medewerker op naam daar volstaat.
