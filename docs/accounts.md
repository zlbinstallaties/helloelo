# Accounts, inloggen en monteurs toevoegen

Monteurs hebben een eigen account voor het dashboard, door een planner aangemaakt. Een monteur ziet alleen zijn
eigen afspraken uit de Odoo-planning. De planner kan een monteur vanuit het dashboard als **medewerker in Odoo**
aanmaken, zodat hij in Odoo Planning kan worden ingepland. De monteur krijgt **geen Odoo-account**: er wordt alleen
een `hr.employee` aangemaakt, zonder `user_id`.

> **Stand (2026-10-06):** gebouwd en getest met nagebootste Odoo, daarna **één keer geprobeerd op een lokale weggooi-Odoo 20
> Enterprise** (zie `docs/verification.md`, "Eerste keer tegen een echte Odoo 20"). **Niet** geprobeerd op de testserver of
> in productie, en **nog niet geschikt voor een gepubliceerd dashboard** (zie "Wat nog moet"). Het aanmaken in Odoo staat
> standaard **uit** en gaat pas aan als de beheerder in de gateway een verantwoordelijke instelt.

## Rollen

| Rol | Wat | Hoe |
|---|---|---|
| `admin` (planner) | ziet alle afspraken, met links naar Odoo; mag vernieuwen; beheert accounts; mag monteurs toevoegen | account in `accounts.json`, of het noodaccount uit de serverinstellingen |
| `monteur` | ziet alleen de afspraken van de persoon waaraan het account hangt, zonder links naar Odoo; kan niet vernieuwen of beheren | account in `accounts.json` |

"Planner" is dezelfde rol als `admin`. Wil je een planner die monteurs mag toevoegen maar geen accounts mag beheren,
dan is dat een derde rol; de bevoegdheden staan op één plek (`src/lib/authorization.ts`).

Een monteur zonder gekoppelde persoon, of met een persoon die nergens is ingepland, ziet niets (nooit alles).

## Monteur toevoegen (de planner)

1. Planner kiest **Beheer, Monteur toevoegen** en vult een naam en een gebruikersnaam in. Meer is niet nodig.
2. De server controleert rol, sessie en invoer, en of het account kan bestaan (vrije gebruikersnaam), **voordat** Odoo
   wordt gevraagd.
3. De aanvraag komt in het journaal (`employee-requests.json`), dan vraagt het dashboard de gateway om één
   medewerker.
4. De gateway controleert dat de ingestelde verantwoordelijke geldig is, maakt de `hr.employee` aan en leest hem terug.
5. Pas als Odoo het nummer bevestigt, wordt het portaalaccount gemaakt, gekoppeld aan `employee:<nummer>`.
   De naam speelt geen rol in de koppeling.
6. Het scherm toont het Odoo-nummer en het wachtwoord, **één keer**. Bij een fout staat er een foutmelding en geen
   succes; er wordt dan geen account gemaakt.

Wat de browser meestuurt is alleen `requestId`, `name` en `username`. Bedrijf, verantwoordelijke, waarden, model en
rol kunnen er niet in: onbekende velden worden geweigerd, ook door de gateway.

### Wat er naar Odoo gaat

Per aanmaak, en niets anders (`src/lib/odoo-client.ts`, getest met een nagebootste verbinding):

| Aanroep | Doel |
|---|---|
| `res.users` `search_read`, één record, velden `id active share company_ids` | is de verantwoordelijke actief, intern en van het bedrijf |
| `planning.role` `search_read`, alleen als er rollen zijn ingesteld, veld `id` | bestaan de ingestelde planningsrollen en zijn ze niet gearchiveerd |
| `hr.employee` `create`, één record met `name`, `company_id`, `hr_responsible_id`, `user_id: false`, `date_version` en, als ingesteld, `planning_role_ids` en `default_planning_role_id` | de medewerker |
| `hr.employee` `search_read`, één record, velden `id name company_id user_id active` (plus `planning_role_ids` als er rollen zijn ingesteld) | terugkijken: geen Odoo-gebruiker, juiste bedrijf, de rollen |

Er wordt nooit een `res.users` aangemaakt of gewijzigd, en nooit een planning of dienst. De planningsrol komt uit de
gatewayconfig (`planningRoleIds`), nooit uit de browser; zonder rol kan een dienst met een rol niet aan de monteur worden
toegewezen, en het scherm zegt dat ("Nog geen planningsrol").

### Wat Odoo 20 er zelf bij doet

Gelezen in de Odoo 20.0-broncode (`hr`, `rpc`), niet uitgeprobeerd. Een `hr.employee` is in Odoo 20 een koppeling met
een `hr.version` (`_inherits`): `hr_responsible_id` en `date_version` horen bij die versie, worden bij `create` in de
waarden van de medewerker meegegeven en daar door Odoo uit elkaar gehaald. Beide zijn verplicht (standaard: de
aanroepende gebruiker en vandaag), en ze hebben `groups="hr.group_hr_user"`. Bij het aanmaken maakt Odoo zelf ook:

- een `resource.resource` en de eerste `hr.version` (zonder contract: `contract_date_start` blijft leeg);
- een **werkcontact** (`res.partner`) met de naam van de medewerker. Dat is een contactkaart, geen gebruiker en geen
  login, maar het is wel een extra record in Odoo;
- een avatar, en een **interne notitie** in de chatter van de medewerker met de tekst "Congratulations! May I recommend
  you to setup an onboarding plan?". Dat is een log, geen mail (`_message_log_batch`).

Daarom geldt voor de gebruiker achter de gateway-sleutel dat hij **HR-medewerker (`hr.group_hr_user`) moet zijn**, anders
kan Odoo het aanmaken of de velden `hr_responsible_id` en `date_version` weigeren (veldrechten `groups=...`; dat gedrag is
niet uitgeprobeerd). Dat is meer dan leesrechten: gebruik voor het
live dashboard een eigen gateway met een eigen sleutel, zodat die rechten niet voor andere projecten gelden.

Het domein van `hr_responsible_id` in Odoo is: interne gebruiker, van het bedrijf, en lid van `hr.group_hr_user`. Dat
domein is een filter voor het formulier; Odoo past het niet toe bij een `create` via de API, en de gateway controleert
de groep niet (wel: bestaat, actief, intern, bedrijf). Kies dus als verantwoordelijke een HR-medewerker.

### Dubbele aanvragen

Een aanvraag heeft een `requestId` die de browser bij het openen van het formulier maakt en bij elke herhaling
meestuurt. Het dashboard (journaal op schijf) en de gateway (geheugen, 24 uur) herkennen een herhaling:

| Situatie | Gevolg |
|---|---|
| herhaling na een gelukte aanvraag | hetzelfde antwoord, zonder wachtwoord, niets nieuws |
| twee klikken tegelijk | de tweede wordt geweigerd |
| Odoo antwoordde met een fout | er is niets aangemaakt; dezelfde aanvraag mag opnieuw |
| geen bruikbaar antwoord (time-out, netwerk) | **onbekend of de medewerker bestaat**: de aanvraag wordt niet opnieuw naar Odoo gestuurd; de planner kijkt in Odoo |
| het account kon niet worden gemaakt nadat Odoo bevestigde | dezelfde aanvraag maakt alleen nog het account af, eventueel met een andere gebruikersnaam |

Dat de gateway zelf na een herstart zijn geheugen kwijt is, wordt opgevangen doordat het dashboard een onbekende
uitkomst nooit opnieuw verstuurt. Twee verschillende mensen met dezelfde naam zijn twee medewerkers: dat kan.

## Instellen

**Dashboard** (serveromgeving, `src/lib/wiring.server.ts`):

| Variabele | Doel |
|---|---|
| `DIG_SESSION_SECRET` | minstens 32 bytes; ondertekent de sessies. **Zonder deze variabele weigert het dashboard alles** (het valt nooit terug op open) |
| `DIG_DATA_DIR` | map voor `accounts.json` en `employee-requests.json` (standaard `./data`, schrijfbaar en bewaard; staat in `.gitignore`) |
| `DIG_ADMIN_USERNAME`, `DIG_ADMIN_PASSWORD_HASH` | het noodaccount (standaard `admin`); de hash maak je met `bun run preview:password '<wachtwoord>'` |
| `DIG_AUTH=off` | zet inloggen uit (previews, ontwikkeling, de probe van de agent): het dashboard is dan open en alleen-lezen, zonder accountbeheer en zonder Odoo-schrijfactie |
| `DIG_SECURE_COOKIES` | `false` voor gewoon http (standaard: veilig in productie) |
| `DIG_TRUST_PROXY=true` | achter een vertrouwde proxy: het laatste adres van `X-Forwarded-For` telt als het adres van de bezoeker |

`/api/health` meldt `degraded` (503) zolang inloggen aan staat maar `DIG_SESSION_SECRET` ontbreekt.

**Gateway** (`docs/odoo-gateway.md`): het aanmaken staat alleen aan voor een project met

```json
"actions": { "createEmployee": { "responsibleUserId": <id van de Odoo-gebruiker die verantwoordelijk wordt> } }
```

Geef dit aan een **eigen project en token voor het live dashboard**, nooit aan het project van een preview of de agent.
`responsibleUserId` moet een actieve, interne Odoo-gebruiker van het bedrijf zijn; de gateway controleert dat bij
elke aanvraag. Zonder dit blok antwoordt de gateway `action_not_allowed` en gebeurt er niets.

## Beveiliging

- Sessie, account en rol worden bij **elke** aanvraag opnieuw gecontroleerd. Een sessie noemt het account en een
  sessieversie: uitschakelen, een andere rol of persoon, of een nieuw wachtwoord beëindigt alle sessies meteen.
- Elke aanvraag die iets wijzigt vereist de header `X-Dig-Dashboard: 1`, naast de cookie (`HttpOnly`,
  `SameSite=Strict`, `Secure`). Uitloggen wist de cookie; de ondertekende sessie zelf blijft tot hij verloopt (12 uur)
  geldig als iemand hem heeft gekopieerd.
- Wachtwoorden: scrypt-hash, nooit het wachtwoord zelf; minstens 12 tekens; gegenereerde wachtwoorden worden één
  keer getoond en staan nergens op schijf. Er is geen tweede wachtwoordopslag.
- Mislukte pogingen worden geteld per adres en per gebruikersnaam; een geslaagde login wist alleen de teller van die
  gebruikersnaam. Gevolg: iemand kan een gebruikersnaam 15 minuten blokkeren door er vaak naast te raden.
- Een kapot `accounts.json` of `employee-requests.json` is een fout en wordt nooit stil leeggemaakt. Het noodaccount
  werkt dan nog.
- Een monteur krijgt geen links naar Odoo, kan niet vernieuwen (dat kost tot ongeveer 20 leesaanroepen) en ziet geen
  keuzelijst met collega's.

## De koppeling tussen account en planning, en de beperking daarvan

Een account hangt aan een persoon-id zoals `employee:41`. Een Odoo-gebruiker en een medewerker zijn verschillende
records; ze gelden alleen als één persoon als één planning ze onder dezelfde naam noemt. Een persoon onthoudt de
andere id's waaronder hij bekend is (`alsoIds`), zodat een koppeling niet breekt als de planning hem later anders noemt.

Een nieuwe monteur staat pas in de lijst met personen van de planning als hij in Odoo Planning is ingepland; tot
dan toont het beheerscherm "Nog niet ingepland in Odoo". De technicus van een **bezoek** is een Odoo-gebruiker; een
monteur zonder Odoo-gebruiker komt dus alleen via de planning (`employee_ids` van de afspraak) in beeld, en een
bezoek zonder planning is alleen voor planners zichtbaar.

## Niet bewezen

- **Alleen lokaal op één Odoo 20 Enterprise-build (`20.0+e.20261004`) geprobeerd**, met de gebruiker `admin` en een
  weggooi-database. Daar nam Odoo de aanroep aan en kwam er een medewerker zonder Odoo-gebruiker uit (zie
  `docs/verification.md`). Niet geprobeerd: de testserver, productie, een gebruiker met alleen Medewerkers: Officer, en
  jullie eigen modules (`svs`).
- Rechten en regels van **jullie** database (toegangsregels, eigen modules zoals `svs`, de sleutelgebruiker en zijn
  groepen) zijn dus niet bekeken. Controleer op de testserver (de gateway meldt een model of veld dat er niet is).
- Of de contextsleutels `mail_create_nosubscribe` en `mail_auto_subscribe_no_notify` alle volgers voorkomen, en of de
  interne onboardingnotitie bij jullie is uitgezet of anders gaat. Lokaal stond er een interne notitie met
  "Employee created" en "Congratulations! May I recommend ... onboarding plan", beide door de aanroepende gebruiker.
- Planning is een Enterprise-module; de broncode is hier niet gelezen. Wat is waargenomen (door de gebruiker, lokaal): een
  dienst met de functie Monteur kan alleen worden toegewezen aan iemand die die functie heeft; zonder werkt het niet.
  Daarom zet de gateway bij het aanmaken een vaste planningsrol (`planningRoleIds`). De velden zijn `planning_role_ids` en
  `default_planning_role_id` (naar `planning.role`); dat Odoo ze in de aanroep van het dashboard aanneemt is **alleen met
  nagebootste antwoorden getest**, niet tegen een echte Odoo.
- Hoe jullie Odoo `employee_ids` en `user_ids` van een dienst aanlevert (aangenomen: `[id, naam]`-paren).

## Wat nog moet: een gepubliceerd dashboard

Een gepubliceerd dashboard draait nu **alleen-lezen, zonder blijvende opslag, zonder geheimen en achter één gedeeld
wachtwoord van de proxy** (`docs/dig-builder-sandbox.md`). Zo kan het de accounts, het journaal en de sessiesleutel
niet bewaren. Daarvoor is een wijziging aan de sandbox nodig, en die verandert de beveiligingsgrenzen:

1. een blijvende, schrijfbare map per project (gedeeld tussen oude en nieuwe versie bij het omschakelen);
2. toestaan dat `DIG_SESSION_SECRET` en `DIG_ADMIN_PASSWORD_HASH` als omgevingsvariabele de container in gaan
   (nu geweigerd door de geheimenfilter van de sandbox);
3. de gedeelde proxy-login niet vóór het live dashboard zetten, zodat monteurs alleen hun eigen login nodig hebben.

Tot die stap kan het dashboard met inloggen (`DIG_AUTH` niet `off`) draaien op een gewone Node-server, en blijven
previews met `DIG_AUTH=off` werken (`sandbox/previews.example.json`).
