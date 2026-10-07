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

**Niet bewezen:** (1) rechten, toegangsregels en eigen modules van jullie database, en of de contextsleutels volgers en
meldingen helemaal voorkomen; (2) de werking met een gebruiker met alleen Medewerkers: Officer; (3) welke Odoo-gebruiker als
verantwoordelijke moet gelden: die staat bewust nergens in de repository. Zie hieronder voor wat wel lokaal is gezien.

## Eerste keer tegen een echte Odoo 20

Lokaal op een weggooi-database (Odoo 20 Enterprise `20.0+e.20261004`, Python 3.12, PostgreSQL 17, modules `hr` en `planning`),
met de gebruiker `admin` en een API-sleutel met bereik RPC. Gedaan door de gebruiker, op aanwijzing; daarbij is niets in
de VPS, de testserver of productie gedaan.

| Wat | Uitkomst |
|---|---|
| De gateway bereikt Odoo met de sleutel | `planning.slot` `search_count` via de gateway gaf `{"count":0}`: sleutel, bereik RPC, database en bedrijfsfilter werken |
| "Monteur toevoegen" in het dashboard | na het toevoegen stond er een `hr.employee` (nummer 1, de naam met kleine letters zoals ingetypt) in Odoo |
| Geen Odoo-gebruiker | `search_read` gaf `"user_id": false`; op het formulier stond **Not Invited**. De knop *Invite* is niet gebruikt: die maakt wél een gebruiker. Niet nagekeken: de lijst met gebruikers |
| Vormen van de antwoorden | `[1, "proef monteur"]` voor een many2one, `false` voor een leeg veld, `[1]` voor een many2many: zoals het teruglezen ze verwacht |
| Wat Odoo zelf toevoegde | een resource (`resource_id`), een eerste versie met de datum van vandaag (6 okt.), werkrooster 40 uur per week, contract "Niet in dienst", en twee interne notities ("Employee created" en de onboardingnotitie). Het werkcontact is niet bekeken |
| Planning | de gebruiker zag dat een dienst met de functie Monteur alleen aan iemand met die functie kan worden toegewezen; zonder die functie werkt het niet. Een eerdere opmerking van mij dat een monteur zonder rol ook in Planning kwam was een verkeerd gelezen antwoord en is ingetrokken |

Gevolg: de planner kiest bij het toevoegen de planningsrollen, en de gateway geeft ze mee, met een controle vooraf en teruglezen (zie hieronder, "Planningsrollen bij het aanmaken"). Niet gezien: het bedrijf van de medewerker, de logregel van de gateway voor het aanmaken en of het antwoord `verified: true` gaf, wie als verantwoordelijke
op het formulier stond (het scherm daarvan is niet bekeken), de herhaling met dezelfde aanvraag tegen deze Odoo, en het
dashboard-overzicht (zonder jullie module `svs` kan het de bezoeken niet lezen).

Wat het opleverde voor de code: `/v1/schema` meldt nu een model dat de database niet heeft in plaats van helemaal te
falen (`unknownModel`); en voor de handleiding: Odoo 20 vraagt Python 3.12 en PostgreSQL 16 of hoger, en de Enterprise-download
is een Python-pakket zonder `odoo-bin` (`docs/lokaal-testen.md`).

## Planningsrollen bij het aanmaken, gekozen door de planner

De planner vinkt bij "Monteur toevoegen" rollen aan die uit Odoo komen (`GET /v1/planning-roles`, een vaste leesaanroep van
`planning.role`). De keuze gaat als `planningRoleIds` naar de gateway, die ze controleert (bestaan, niet gearchiveerd, en bij
een beperking in de config toegestaan: `allowedPlanningRoleIds`), ze meegeeft als `planning_role_ids` (Odoo-opdracht
`[[6, 0, [id's]]]`) met de eerste als `default_planning_role_id`, ze teruglees en meldt hoeveel hij bevestigd ziet
(`planningRoles`). Het scherm toont de rollen of waarschuwt "Nog geen planningsrol". Een eerdere versie had één vaste rol in de
gatewayconfig; dat is vervangen omdat de planner de rollen zelf wil kiezen.

| Controle | Uitkomst |
|---|---|
| Gateway en client | de rollen van een verzoek zijn een korte lijst van verschillende positieve nummers (anders 400); andere namen blijven 400; een verzoek met dezelfde id maar andere rollen of een andere volgorde is geen herhaling; de lijstroute werkt alleen voor een project met de actie, alleen met GET, en alleen met de toegestane rollen |
| Dashboard | de keuze gaat door de handler, de service en het journaal (ook bij herhalingen), de lijst is alleen voor een ingelogde admin, en een mislukte lijst is een duidelijke fout |
| Hele keten met nagebootste Odoo | lijst, keuze, `planning_role_ids` `[[6,0,[4,3]]]` met standaard 4, een rol die weg is stopt alles vóór er een medewerker is, een beperking van het project |
| Echte processen en Chromium (demo-Odoo) | de lijst toont de rollen op naam zonder de gearchiveerde, de waarschuwing verdwijnt na kiezen, de aanmaak bevat de opdracht met de gekozen volgorde en `user_id: false`; zonder rol: waarschuwing en geen rol naar Odoo |
| Opzettelijke fouten | 25 + 25 in gateway, client en dashboard; allemaal gevangen |
| Gezien op een echte lokale Odoo 20 Enterprise | het lezen van `planning.role` werkt: de rol die in Odoo is aangemaakt staat als vinkje in het dashboard. Een medewerker (`manbakker`, schermafbeelding van de gebruiker) heeft *Gebruiker: Geen gebruiker gekoppeld*, *Functies: monteur*, *Standaardrol: monteur* en Hr-verantwoordelijke Administrator: `planning_role_ids` en `default_planning_role_id` worden bij het aanmaken dus aangenomen |
| Gezien op een echte lokale Odoo 20 Enterprise (nogmaals) | een monteur aangemaakt vanuit het dashboard met de rol `monteur`: Odoo bevestigde de rol bij het terugkijken (medewerker 6, schermafbeelding van de gebruiker) |
| Niet gedaan | tegen een echte Odoo 20: of de rol dan bij een dienst in Planning te kiezen is, en `write` (rollen achteraf wijzigen, zie hieronder) |

### Rollen van een bestaande medewerker later wijzigen (knop Planningsrollen bij Accounts)

De gateway kan de planningsrollen van **één bestaande** medewerker zetten (`set_employee_planning_roles`) en lezen
(`GET /v1/employees/<id>/planning-roles`), onder een eigen instelling `setEmployeePlanningRoles` die uit staat. Het dashboard
gebruikt dit voor de knop **Planningsrollen** bij een monteur die aan een Odoo-medewerker hangt (`docs/accounts.md`).

| Laag | Wat is gecontroleerd |
|---|---|
| Gateway en client | zie hierboven: de gateway-tests (79 in totaal) en de clienttests (31); 14 opzettelijke fouten, 13 gevangen, de overlevende is gelijkwaardig (de instelling wordt vóór het lezen van het verzoek gecontroleerd, en ook binnenin) |
| Dashboard | het nummer van de medewerker komt uit het account; alleen een monteur met `employee:<nummer>`; alleen de planner, met het kopje; alleen het veld `planningRoleIds` (elk ander veld `400`); 0 tot 5 verschillende positieve nummers; foutantwoorden van de gateway worden duidelijke meldingen (404, 502, "niets gewijzigd", "geen bruikbaar antwoord: herhalen mag"); het antwoord noemt het aantal dat Odoo bevestigde, niet het aantal dat gevraagd was (`test/admin-handlers.test.ts`, `test/gateway-employee.test.ts`, `test/employee-chain.test.ts`; 293 app-tests in totaal) |
| Echte processen en Chromium (demo-Odoo) | monteur zonder rol aanmaken; venster toont de rollen uit Odoo en "Opslaan" is uit zolang er niets veranderd is; Planner en dan Monteur aanvinken geeft precies één `write` op het nummer van de monteur met `[[6,0,[2,1]]]` en standaard 2, zonder gebruiker; heropenen leest opnieuw (beide aangevinkt, Planner standaard); één rol weghalen en alle rollen weghalen geven elk één `write`; Odoo weigert: melding, de keuze blijft staan; maar deels bevestigd: rode melding met de aantallen; Odoo onleesbaar: geen opslaanknop, wel "Opnieuw proberen"; zonder kopje `403`, extra veld of dubbele rol `400`, onbekend account `404`, onbekende rol in Odoo: geweigerd en geen `write`; geen browserfouten |
| Opzettelijke fouten | 22 in de dashboardcode (client voor de gateway, handlers): 17 direct gevangen; van de 5 overlevers zijn er 4 gevangen na extra tests (status niet gecontroleerd, rol van het account niet gecontroleerd, te lang medewerkernummer niet afgekapt, bevestigd aantal = gevraagd aantal) en 1 gelijkwaardig (de planner-controle staat er dubbel: ook de beheerders-bewaking eist al een planner) |
| Niet gedaan | tegen een echte Odoo 20: of `write` op `hr.employee` met `planning_role_ids` en `default_planning_role_id` wordt aangenomen (de demo-Odoo is daar streng in, maar is niet Odoo), en of een gewijzigde rol meteen te kiezen is bij een dienst. Test ook met een gateway-gebruiker die alleen Werknemers: Officer en Planning-leesrechten heeft; alle lokale tests gebruikten `admin` |

## Beschikbaarheid doorgeven (dashboard, en één record per periode in Odoo)

`docs/beschikbaarheid.md`. De monteur geeft periodes door waarin hij niet beschikbaar is; de planner ziet ze; ze gaan ook naar Odoo.

| Laag | Wat is gecontroleerd |
|---|---|
| Opslag (`test/availability.test.ts`, 16 tests) | echte kalenderdagen, laatste dag niet voor de eerste, 366 dagen (367 geweigerd), twee jaar vooruit (grens exact), vandaag in Nederlandse tijd (ook rond middernacht UTC, zomer en winter), opmerking van 200 tekens zonder regeleinden of stuurtekens, overlap (aansluiten mag, een ander niet geraakt), 50 per persoon (verlopen tellen niet mee), alleen de eigenaar verwijdert, oude periodes verdwijnen na 30 dagen, een beschadigd bestand wordt geweigerd en niet overschreven, ook het deel over Odoo wordt gecontroleerd |
| Handlers (`test/availability-handlers.test.ts`, 20 tests) | monteur ziet alleen zijn eigen periodes, de planner alles maar kan niets wijzigen (403), geen login 401, zonder kopje 403, inloggen uit 404, alleen de velden `from`, `to`, `note` (een account, medewerker, id of iets van Odoo: 400), overlap 409, de periode van een ander is 404, een verwijderd account neemt zijn periodes mee; naar Odoo met het nummer van de periode als aanvraag-id, de toestand per periode (in Odoo, alleen dashboard, niet gelukt, onzeker), opnieuw proberen alleen voor een geweigerde of nooit verstuurde periode, verwijderen haalt eerst het record in Odoo weg met wat bewaard is (ook als het account later aan een ander gekoppeld is) en laat de periode staan als dat niet lukt, het recordnummer van Odoo gaat nooit naar de browser, een te lang medewerkernummer wordt niet afgekapt |
| Gateway (`gateway/test/unavailability.test.ts`, 18 tests; `zoned.test.ts`, 6; `projects.test.ts`) | actie uit tenzij aangezet; alleen `requestId`, `employeeId`, `from`, `to`, `note`; ongeldige id's, dagen en notities een 400; medewerker moet bestaan, actief zijn, in het bedrijf staan, een resource en een bekende tijdzone hebben; precies één `create` met de vaste velden in de tijdzone van de medewerker; herhaling geeft hetzelfde record, andere gegevens 409, tegelijk lopend 409, geen antwoord blokkeert de aanvraag, een weigering mag opnieuw; terugkijken geeft `verified`; limiet per uur voor toevoegen en verwijderen samen; verwijderen raakt alleen een record met de herkenning én van die resource (andere resource, record van niemand, met de hand gemaakt, bijna-herkenning: 404 en niets verwijderd); dagen over zomer- en wintertijd, een halfuur-tijdzone en Nieuw-Zeeland kloppen |
| Client (`scripts/test-odoo-client.mjs`, 36 tests) | één `create`, één `unlink`, één vaste lezing; alleen de vaste velden; vreemde waarden voor het verzenden geweigerd; de uitkomst van een mislukking juist (geweigerd of onzeker) |
| Chromium met echte processen en de demo-Odoo (18 controles) | een periode wordt **In Odoo** met precies één record `[Dashboard] Niet beschikbaar: ...` voor de resource van de medewerker, van 00:00:00 tot 23:59:59 Nederlandse tijd en zonder ander veld; de planner ziet het ook; een medewerker of Odoo-record meesturen: 400; verwijderen doet precies één `UNLINK`; een monteur die in de demo-Odoo geen medewerker is, krijgt "Niet in Odoo gekomen" met de reden, een werkende opnieuw-knop, niets nieuws in Odoo en bij verwijderen geen vraag aan Odoo; geen browserfouten |
| Opzettelijke fouten | 70 in opslag, handlers, gateway, client en tijdzonehulp; alle gevangen (enkele pas na extra tests; één is gelijkwaardig: de controle of de actie aan staat zit er dubbel) |
| Gezien op een echte lokale Odoo 20 Enterprise | het model `resource.calendar.leaves` heeft de velden `name`, `date_from`, `date_to` (verplicht), `resource_id` en `calendar_id` en geen `holiday_id` of `time_type` (de app Verlof is niet geïnstalleerd); een door het dashboard doorgegeven periode kwam volgens de gebruiker in Odoo te staan |
| Niet gedaan | tegen een echte Odoo 20 nog niet bekeken of bevestigd: de exacte begin- en eindtijd van het record, of Planning de dagen als niet beschikbaar toont, het verwijderen van het record vanuit het dashboard, en de rechten van een gateway-gebruiker die geen `admin` is; echte telefoons en andere browsers dan Chromium |

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
