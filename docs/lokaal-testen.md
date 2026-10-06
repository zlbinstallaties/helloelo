# Lokaal testen met Odoo 20

Zo draai je het dashboard, de gateway en een Odoo 20 op je eigen computer, en voeg je een proefmonteur toe. Er komt
niets op de VPS en niets in productie.

> **Stand (2026-10-06):** het pakket (setup, demo-Odoo, stappen 0 en 3 tot 5) is met echte processen geprobeerd tegen
> de demo-Odoo van `scripts/demo-odoo.mjs`, **niet** tegen een echte Odoo. De stappen met Odoo 20 (1, 2 en 6) zijn
> hier niet uitgevoerd: de Odoo 20-code en Enterprise staan op jouw computer.

Alle commando's draai je in de hoofdmap van deze repository, met Node 22 en Bun. De bestanden die het setup-script
schrijft staan in `.local/` en komen niet in git.

## 0. Eerst oefenen met de demo-Odoo (aanbevolen, 5 minuten)

De demo-Odoo is een stuk gereedschap in `scripts/demo-odoo.mjs`: geen echte Odoo, maar met voorbeeldplanning en
net genoeg `res.users` en `hr.employee` om "Monteur toevoegen" na te spelen. Verantwoordelijke 2 is geldig; 3 is een
portaalgebruiker, 4 is gedeactiveerd en 99 bestaat niet.

```bash
bun run local:demo-odoo                      # terminal 1, poort 18069; elke aanmaak staat in het scherm
bun run local:setup --odoo-url http://127.0.0.1:18069 --company-id 2 --responsible-id 2
# zet in .local/gateway.env:  ODOO_API_KEY=demo
bun run local:gateway                        # terminal 2
bun run build && bun run local:dashboard     # terminal 3
```

Open `http://127.0.0.1:3000`, log in met `admin` en het wachtwoord dat `local:setup` toonde, kies **Beheer** en voeg
een monteur toe. In terminal 1 staat dan precies één `CREATE hr.employee` met `user_id: false`.

## 1. Odoo 20 lokaal starten

Je hebt een lokale Postgres nodig. Daarna, in de map met de Odoo 20-broncode:

```bash
# nieuwe, lege database
./odoo-bin -d dig-test --addons-path=addons,odoo/addons,<pad-naar-enterprise>,<pad-naar-jullie-modules> -i hr,planning

# of een kopie van een back-up, geneutraliseerd (geen mail, geplande acties of betalingen)
./odoo-bin db load --neutralize dig-test <back-up.zip>
./odoo-bin -d dig-test --addons-path=addons,odoo/addons,<pad-naar-enterprise>,<pad-naar-jullie-modules>
```

Zet de map met jullie eigen modules (waar `svs` in zit) in het `--addons-path`, anders kan het dashboard de bezoeken
niet lezen. Gebruik nooit de productiedatabase of productiegegevens. Open `http://localhost:8069`.

## 2. In Odoo: een gebruiker voor de gateway

1. Maak een Odoo-gebruiker voor de gateway, met het toegangsrecht **Medewerkers: Officer** (`hr.group_hr_user`) en
   leesrechten op Planning en de DIG-bezoekformulieren. Daarmee mag hij ook een medewerker aanmaken.
2. Maak voor die gebruiker een API-sleutel (voorkeuren, tabblad Accountbeveiliging; de naam van het scherm kan in Odoo 20
   anders zijn). De sleutel zie je één keer.
3. Kies de **verantwoordelijke** voor nieuwe medewerkers: een actieve, interne gebruiker van het bedrijf, bij voorkeur ook
   Medewerkers: Officer. Dat mag dezelfde gebruiker zijn. Het nummer staat in de adresbalk als je de gebruiker opent.
4. Zoek het nummer van het bedrijf op dezelfde manier (de lokale database heeft meestal `1`).

## 3. Het dashboard en de gateway instellen

```bash
bun run local:setup --odoo-url http://localhost:8069 --database dig-test --company-id <bedrijfsnummer> --responsible-id <gebruikersnummer>
```

Het script toont één keer het adminwachtwoord (het staat daarna alleen als hash op schijf) en schrijft `.local/`.
Zet vervolgens zelf de API-sleutel achter `ODOO_API_KEY=` in `.local/gateway.env`; het script vraagt er niet om en
schrijft hem nergens. Draai het script opnieuw met `--force` voor een nieuw token en wachtwoord. Het script weigert
`*.odoo.sh` en `*.odoo.com`, net als de gateway. Zonder `--responsible-id` staat "Monteur toevoegen" uit.

## 4. Starten en controleren

```bash
bun run local:gateway                        # terminal 1
curl -s http://127.0.0.1:8070/healthz
TOKEN=$(grep '^DIG_GATEWAY_TOKEN=' .local/dashboard.env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8070/v1/schema     # let op "missing"
bun run build && bun run local:dashboard     # terminal 2
```

`missing` in het schema noemt velden die wel in de allowlist staan maar niet in jouw database bestaan: die zijn te
herstellen voordat je verder gaat. Open `http://127.0.0.1:3000` en log in als `admin`.

## 5. De proef

1. **Beheer, Monteur toevoegen**: naam `Proef Monteur`, de voorgestelde gebruikersnaam. Noteer het Odoo-nummer en het
   wachtwoord.
2. Controleer in Odoo (Medewerkers):
   - de medewerker bestaat, in het juiste bedrijf, met de juiste verantwoordelijke;
   - **Gerelateerde gebruiker is leeg**, en onder Instellingen, Gebruikers is er geen nieuwe gebruiker bij gekomen;
   - Odoo heeft zelf een werkcontact en een interne notitie in de chatter gemaakt (verwacht, zie `docs/accounts.md`);
   - er is geen planning of dienst aangemaakt.
3. **Planning:** komt de medewerker daar voor? Wat moet je instellen om hem beschikbaar te krijgen? Stuur me
   (a) wat je instelde en (b) zo nodig de uitvoer van
   `grep -rn "planning_role_ids\|default_planning_role_id" enterprise/planning/models/hr_employee.py`. Met die veldnamen
   kan ik een vaste planningsrol in de gateway-config bouwen.
4. Klik in het scherm nog eens op toevoegen met dezelfde gegevens (herhaling): er mag geen tweede medewerker komen.
5. Log in als de nieuwe monteur: hij ziet alleen zijn eigen afspraken en geen Beheer. Hij staat pas in de lijst van de
   planning zodra hij is ingepland.

## 6. Als er iets misgaat

| Melding | Betekenis |
|---|---|
| "staat niet aan op de server" | de gateway heeft geen `actions.createEmployee`: draai `local:setup` met `--responsible-id` |
| "verantwoordelijke ... niet geldig" | de gebruiker is niet actief, niet intern of niet van het bedrijf; er is niets aangemaakt |
| "Er kwam geen bruikbaar antwoord van Odoo. Het is niet zeker of de medewerker is aangemaakt" | time-out of netwerkfout; kijk in Odoo of hij er is. Dezelfde aanvraag wordt niet nog eens verstuurd |
| "aangemaakt, maar niet zoals bedoeld" | de medewerker heeft een Odoo-gebruiker of staat in een ander bedrijf; verwijder hem handmatig en meld het |
| gateway start niet | `ODOO_API_KEY` is leeg, of de host staat niet in `ODOO_ALLOWED_HOSTS` |

Stuur me bij een fout de regel uit de gatewaylog (staat in terminal 1; bevat geen tokens) en de melding op het scherm,
nooit `.local/dashboard.env` of de API-sleutel.

## Opruimen

Stop de drie processen, verwijder `.local/` en verwijder de proefmonteur in Odoo, of de hele lokale database.
