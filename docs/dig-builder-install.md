# DIG Builder op de Hostinger-VPS zetten

Een installatiescript (`deploy/install/`) zet het hele systeem op een server die al een Odoo-testserver
met Caddy draait. Het is gemaakt voor de VPS `srv1938209.hstgr.cloud`, waar Caddy **in een Docker-container** draait
(`odoo20-test-proxy-1`, hostnetwerk, `admin off`, het Caddyfile staat in `/opt/odoo20-test/Caddyfile`). Het script
herkent dat zelf, en ook een Caddy die als systeemdienst draait. Het is geoefend op een nagebouwde kopie van die situatie
met echte Docker en dezelfde Caddy-versie (v2.11.6). Op de echte VPS is het nog niet uitgevoerd.

## Wat het wel en niet doet

Het doet:
- een systeemgebruiker `dig-builder` aanmaken, met mappen `/srv/dig-builder` en `/etc/dig-builder`
- de code ophalen en de sandbox-afbeelding bouwen (`dig-sandbox:1`)
- een intern Docker-netwerk `dig-preview` maken waar de apps in draaien zonder internet
- de Odoo-gateway starten (alleen-lezen, zonder poort naar buiten) en twee diensten: `dig-preview` en `dig-builder-app`
- de bestaande Caddy aanvullen met **één blok** onderaan het Caddyfile, tussen de regels `# BEGIN DIG Builder` en
  `# END DIG Builder`, met de adressen van de builder en de apps. De werkwijze:
  1. een reservekopie naast het bestand (`Caddyfile.dig-backup-<datum>`)
  2. het bestand **op zijn plaats** aanpassen (een enkel bestand dat in een container is gemonteerd moet zo, anders ziet de
     container de wijziging niet)
  3. Caddy zelf laten controleren (`caddy validate`, in de container, met precies die Caddy-versie)
  4. laden met een signaal (`USR1`), **zonder Caddy te herstarten**: Caddy blijft doorlopen en bevestigt in zijn log
     dat de nieuwe configuratie is geladen. Een gewone `caddy reload` kan niet, omdat `admin off` staat.
  5. controleren dat de Odoo-testserver nog hetzelfde antwoordt als ervoor.
  Wordt de configuratie afgekeurd, weigert Caddy hem te laden, of antwoordt de Odoo-testserver daarna anders, dan wordt
  het bestand teruggezet (en zo nodig opnieuw geladen).

Het doet niet:
- niets aan de containers `odoo20-test-*` of `dig-builder-test-*`, hun netwerken of hun gegevens
- geen tweede webserver op poort 80/443, geen firewallwijzigingen (de diensten luisteren alleen op `127.0.0.1`, dus niet
  op internet; Caddy draait op het hostnetwerk en bereikt ze daar)
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

Als er iets misgaat: `journalctl -u dig-builder-app -n 50 --no-pager`, `journalctl -u dig-preview -n 50 --no-pager` en,
voor Caddy in een container, `docker logs odoo20-test-proxy-1 --tail 50`. De reservekopieën van het Caddyfile staan naast het
bestand (`Caddyfile.dig-backup-<datum>`).

**Let op:** het Caddyfile hoort bij de Odoo-installatie (`/opt/odoo20-test`). Als dat project opnieuw wordt uitgerold of het
bestand wordt vervangen, verdwijnt ons blok. Draai dan `apply` opnieuw; het voegt het blok weer toe.

## Wat er op de server komt te staan

| Plek | Inhoud |
|---|---|
| `/srv/dig-builder/app` | de code van het platform |
| `/srv/dig-builder/apps/dashboard` | het project dat de agent aanpast (de builder beheert deze map) |
| `/srv/dig-builder/builder-data`, `/srv/dig-builder/releases` | opdrachten en geschiedenis, gepubliceerde versies |
| `/etc/dig-builder` | instellingen en geheimen; alleen root leest de geheimen |
| `/opt/odoo20-test/Caddyfile` (of waar Caddy zijn bestand heeft) | ons blok met de adressen, plus een reservekopie ernaast |
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

- 29 tests tegen een nagebootste server (voor Caddy in een container én als dienst): elke stap, opnieuw uitvoeren, ontbrekende sleutels, een door Caddy afgekeurde
  configuratie, een mislukte herlaad, een Odoo-site die anders gaat antwoorden, een dienst die niet start, verwijderen
  (het Caddyfile komt terug zoals het was), en dat geen geheim in een bestand of op het scherm terechtkomt waar het
  niet hoort. De veiligheidsregels zijn met 25 opzettelijke fouten gecontroleerd; elke werd door een test gevonden (een paar pas nadat ik er een test voor had toegevoegd).
- Een echte oefening in een omgeving die lijkt op de VPS (Ubuntu 24.04, echte Docker, een Caddy v2.11.6 in een container
  op het hostnetwerk met `admin off` en een enkel gemonteerd Caddyfile, de diensten echt gestart): installeren vanaf niets,
  gateway gezond, inloggen via Caddy, een app publiceren en openen, opnieuw uitvoeren, verwijderen met en zonder `purge`.
  Caddy is niet herstart (zelfde starttijd en proces) en het Caddyfile kwam na het verwijderen byte voor byte terug.
  De oefeningen vonden twee echte fouten (de agent-bibliotheek miste zijn pakketten; het script nam een Caddy als dienst aan
  terwijl die in een container draait, wat de controle op de echte VPS liet zien); beide zijn opgelost en bewaakt.
- Niet getest: op de echte VPS, met het echte certificaat van Let's Encrypt, en met de echte Odoo-testserver.
