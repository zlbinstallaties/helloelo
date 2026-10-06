# DIG Builder op de Hostinger-VPS zetten

Een installatiescript (`deploy/install/`) zet het hele systeem op een server die al een Odoo-testserver
met Caddy draait. Het is gemaakt voor de VPS `srv1938209.hstgr.cloud` en geoefend op een nagebootste server met echte
Docker en een echte Caddy-controle. Op de echte VPS is het nog niet uitgevoerd.

## Wat het wel en niet doet

Het doet:
- een systeemgebruiker `dig-builder` aanmaken, met mappen `/srv/dig-builder` en `/etc/dig-builder`
- de code ophalen en de sandbox-afbeelding bouwen (`dig-sandbox:1`)
- een intern Docker-netwerk `dig-preview` maken waar de apps in draaien zonder internet
- de Odoo-gateway starten (alleen-lezen, zonder poort naar buiten) en twee diensten: `dig-preview` en `dig-builder-app`
- de bestaande Caddy aanvullen met **één regel** (`import /etc/caddy/dig-builder.caddy`) en een eigen bestand met de
  adressen. Eerst een reservekopie, dan controleren, dan herladen (nooit herstarten). Als Caddy de configuratie afkeurt, het
  herladen mislukt, of de Odoo-testserver daarna anders antwoordt dan ervoor, wordt alles teruggezet.

Het doet niet:
- niets aan de containers `odoo20-test-*` of `dig-builder-test-*`, hun netwerken of hun gegevens
- geen tweede webserver op poort 80/443, geen firewallwijzigingen (de diensten luisteren alleen op het Docker-adres
  van de server, niet op internet)
- geen platte wachtwoorden of sleutels opslaan: het wachtwoord wordt een hash; sleutels staan alleen in
  bestanden die alleen root kan lezen

## Eerst nodig

- Een **Odoo API-sleutel** van een testgebruiker met alleen leesrechten op Planning en de DIG-bezoeken. In Odoo: Instellingen →
  Gebruikers → de gebruiker → tabblad Voorkeuren/Accountbeveiliging → Nieuwe API-sleutel. Je mag dit overslaan en later invullen.
- Een **Claude API-sleutel** voor de bouwagent. Ook overslaanbaar tot later.
- Een wachtwoord van minstens 12 tekens voor de builder en de apps (dezelfde inlog voor beide).

Typ sleutels en wachtwoorden alleen in het terminal van de server, nooit in een chat.

## Installeren

Open het browserterminal van Hostinger (VPS → Browser terminal), als root:

```bash
mkdir -p /srv/dig-builder
git clone https://github.com/zlbinstallaties/helloelo.git /srv/dig-builder/app
cd /srv/dig-builder/app
node --experimental-strip-types --no-warnings deploy/install/main.ts check
```

`check` kijkt alleen en verandert niets. Staat er "Alles ziet er goed uit", dan:

```bash
node --experimental-strip-types --no-warnings deploy/install/main.ts apply
```

Het script vraagt de adressen (de standaardwaarden kloppen voor deze VPS), de sleutels en het wachtwoord (tijdens het typen
verschijnt niets op het scherm; dat is normaal), laat zien wat er gaat gebeuren en vraagt om bevestiging. Daarna volgen
11 stappen. Een nieuw adres kan tot een minuut nodig hebben voor het certificaat; het script wacht daarop en controleert
de adressen.

Daarna:
- builder: `https://bouwen.srv1938209.hstgr.cloud`
- voorbeeldproject: preview op `https://dashboard.apps.srv1938209.hstgr.cloud`, gepubliceerd op
  `https://dashboard-live.apps.srv1938209.hstgr.cloud`

Alle namen onder `srv1938209.hstgr.cloud` wijzen al naar de server; een eigen domein is niet nodig.

## Bijwerken, controleren, terugdraaien

```bash
runuser -u dig-builder -- git -C /srv/dig-builder/app pull        # nieuwe code ophalen
node --experimental-strip-types --no-warnings deploy/install/main.ts apply   # slaat over wat al klaar is
node --experimental-strip-types --no-warnings deploy/install/main.ts status  # wat draait er
node --experimental-strip-types --no-warnings deploy/install/main.ts uninstall          # alles weg behalve code en geheimen
node --experimental-strip-types --no-warnings deploy/install/main.ts uninstall purge    # ook code, gegevens, geheimen en de gebruiker
```

Opnieuw uitvoeren van `apply` is veilig: bestaande tokens en het wachtwoord blijven gelijk, wat al klopt wordt overgeslagen,
en ontbrekende sleutels worden alsnog gevraagd. Een gepubliceerde app blijft draaien terwijl je bijwerkt.

Als er iets misgaat: `journalctl -u dig-builder-app -n 50 --no-pager`, `journalctl -u dig-preview -n 50 --no-pager` en
`journalctl -u caddy -n 50 --no-pager`. De reservekopieën van het Caddyfile staan naast het bestand
(`Caddyfile.dig-backup-<datum>`).

## Wat er op de server komt te staan

| Plek | Inhoud |
|---|---|
| `/srv/dig-builder/app` | de code van het platform |
| `/srv/dig-builder/apps/dashboard` | het project dat de agent aanpast (de builder beheert deze map) |
| `/srv/dig-builder/builder-data`, `/srv/dig-builder/releases` | opdrachten en geschiedenis, gepubliceerde versies |
| `/etc/dig-builder` | instellingen en geheimen; alleen root leest de geheimen |
| `/etc/caddy/dig-builder.caddy` | de adressen voor Caddy |
| `/etc/systemd/system/dig-preview.service`, `dig-builder-app.service` | de twee diensten |

## Let op

- **De gebruiker `dig-builder` zit in de groep `docker`, en dat staat gelijk aan root op deze server.** De agent draait de code die
  hij schrijft in aparte containers zonder internet en zonder rechten, maar de builder zelf bestuurt Docker. Het is een
  testserver (productie staat niet op deze machine), maar de Odoo-testdatabase staat er wel, mogelijk met kopieën van echte gegevens.
- **De repo is openbaar.** Er staan geen wachtwoorden of sleutels in, wel veldnamen van jullie Odoo en de naam van de testserver.
  Overweeg de repo privé te maken; dan moet de server toegang krijgen met een deploy key.
- Er is één gedeeld wachtwoord voor de builder en de apps. Login met Odoo-gebruikers is nog niet gebouwd.
- De voorbeeldwaarden in `deploy/env.example` en `docs/dig-builder-deploy.md` beschrijven de handmatige route; het
  script maakt die overbodig.

## Getest

- 19 tests tegen een nagebootste server: elke stap, opnieuw uitvoeren, ontbrekende sleutels, een door Caddy afgekeurde
  configuratie, een mislukte herlaad, een Odoo-site die anders gaat antwoorden, een dienst die niet start, verwijderen
  (het Caddyfile komt terug zoals het was), en dat geen geheim in een bestand of op het scherm terechtkomt waar het
  niet hoort. De veiligheidsregels zijn met 14 opzettelijke fouten gecontroleerd; elke werd door een test gevonden.
- Een echte oefening in een omgeving die lijkt op de VPS (Ubuntu 24.04, echte Docker, een echte Caddy-controle van
  onze configuratie, de diensten echt gestart): installeren vanaf niets, de gateway gezond, inloggen, een app
  publiceren en openen via de proxy, opnieuw uitvoeren, verwijderen met en zonder `purge`. Dat vond een echte fout
  (de agent-bibliotheek miste zijn pakketten), die is opgelost en bewaakt door een test.
- Niet getest: op de echte VPS, met het echte certificaat van Let's Encrypt, en met de echte Odoo-testserver.
