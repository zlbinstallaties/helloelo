# Lokaal testen met Odoo 20

Zo draai je het dashboard, de gateway en een Odoo 20 op je eigen computer, en voeg je een proefmonteur toe. Er komt
niets op de VPS en niets in productie.

> **Stand (2026-10-06):** doorlopen op een lokale Odoo 20 Enterprise (build `20.0+e.20261004`, Python 3.12,
> PostgreSQL 17), met de proefmonteur die het dashboard aanmaakte. Wat daarbij is gezien staat in
> `docs/verification.md`, "Eerste keer tegen een echte Odoo 20". Alleen een lokale weggooi-database is gebruikt; er is
> niets op de VPS of in productie gedaan.

Alle commando's draai je in de hoofdmap van deze repository, met Node 22 en Bun. De bestanden die het setup-script
schrijft staan in `.local/` en komen niet in git.

## 0. Eerst oefenen met de demo-Odoo (aanbevolen, 5 minuten)

De demo-Odoo is een stuk gereedschap in `scripts/demo-odoo.mjs`: geen echte Odoo, maar met voorbeeldplanning en
net genoeg `res.users` en `hr.employee` om "Monteur toevoegen" na te spelen. Verantwoordelijke 2 is geldig; 3 is een
portaalgebruiker, 4 is gedeactiveerd en 99 bestaat niet. Eén terminal is genoeg:

```bash
bun run local:rehearsal start     # maakt .local (eerste keer), start demo-Odoo, gateway en dashboard, toont het wachtwoord
                                  # bouwt het dashboard zelf opnieuw als de code nieuwer is dan de laatste bouw
bun run local:rehearsal logs      # de demo-Odoo: elke aanmaak staat als regel "CREATE hr.employee ..."
bun run local:rehearsal stop      # stopt alles
bun run local:rehearsal reset     # stopt en verwijdert .local (alleen als het bij de demo hoort)
```

Open `http://127.0.0.1:3000`, log in met `admin` en het getoonde wachtwoord, kies **Beheer** en voeg een monteur toe.
Dan staat er in `logs` precies één `CREATE hr.employee` met `user_id: false`. Is een poort bezet (18069, 8070 of
3000), dan zegt het commando welke en wat je kunt doen. `.local` is voor één Odoo tegelijk: doe `reset` voordat je
`local:setup` voor de echte proef draait. `start` en `reset` raken een `.local` die niet bij de demo hoort nooit aan.

Wat dit commando doet, als je het met de hand wilt: `bun run local:setup --odoo-url http://127.0.0.1:18069
--company-id 2 --responsible-id 2`, in `.local/gateway.env` `ODOO_API_KEY=demo` invullen, en dan in drie terminals
`bun run local:demo-odoo`, `bun run local:gateway` en `bun run build && bun run local:dashboard`.

## 1. Odoo 20 lokaal starten

Wat bij de eerste keer werkte, en waarom:

- **De Enterprise-download is een `.tar` van een Python-pakket (sdist), geen map met `odoo-bin`.** Pak hem uit in een nieuwe,
  lege map en start met `python -m odoo` vanuit de uitgepakte map. De Planning-module staat in `odoo/addons/planning`.
- **Python 3.12 of hoger** (`MIN_PY_VERSION` in `odoo/release.py`). Maak een eigen omgeving (venv) en installeer
  `requirements.txt`. Op een Mac: laat `python-ldap` weg (alleen voor LDAP-login, vraagt systeembibliotheken) en vervang
  `psycopg2` door `psycopg2-binary` (kant-en-klaar, niets te compileren).
- **PostgreSQL 16 of hoger** (`MIN_PG_VERSION`). Met een oudere server (bij ons 14) mislukt de installatie op
  `function any_value(integer) does not exist`. Een bestaande oude server hoef je niet aan te raken: maak een tweede, losse
  Postgres in een eigen map op een andere poort (`initdb` en `pg_ctl` van versie 17, poort 5433).
- Een eigen instellingenbestand (`-c odoo.conf`), zodat een oud `~/.odoorc` er niet doorheen komt, met
  `http_interface = 127.0.0.1` (alleen vanaf deze computer bereikbaar).
- Een nieuwe database via de opdrachtregel krijgt de login `admin` met wachtwoord `admin` (staat in
  `base/data/res_users_data.xml`). Dat is alleen veilig omdat deze Odoo alleen lokaal bereikbaar is.

```bash
# eenmalig
mkdir ~/Developer/odoo20-ee && tar -xf ~/Downloads/odoo-20.0+e.<datum>.tar -C ~/Developer/odoo20-ee
python3.12 -m venv ~/Developer/odoo20-ee/venv && source ~/Developer/odoo20-ee/venv/bin/activate
cd ~/Developer/odoo20-ee/odoo-20.0+e.<datum>
sed -e '/python-ldap/d' -e 's/^psycopg2==/psycopg2-binary==/' requirements.txt > ../requirements-mac.txt
pip install -r ../requirements-mac.txt
initdb -D ~/Developer/odoo20-ee/pgdata -E UTF8 --locale=en_US.UTF-8     # met PostgreSQL 16+ in je PATH
pg_ctl -D ~/Developer/odoo20-ee/pgdata -o "-p 5433" -l ~/Developer/odoo20-ee/pg.log start
python -m odoo -d dig20-test -i hr,planning --without-demo=all --data-dir ~/Developer/odoo20-ee/data --db_port 5433 --stop-after-init
```

Daarna een instellingenbestand `~/Developer/odoo20-ee/odoo.conf` met `db_port = 5433`, `http_interface = 127.0.0.1`,
`http_port = 8071` en `data_dir = ...`, en een startscript (`start`, `stop`, `status`, `log`) dat Postgres en Odoo op de
achtergrond start:

```bash
#!/bin/bash
BASE="$HOME/Developer/odoo20-ee"; SRC="$BASE/odoo-20.0+e.<datum>"; PGDATA="$BASE/pgdata"; PGPORT=5433; PORT=8071; DB=dig20-test
case "$1" in
  start)
    pg_isready -q -p $PGPORT || pg_ctl -D "$PGDATA" -o "-p $PGPORT" -l "$BASE/pg.log" start || exit 1
    cd "$SRC" || exit 1
    nohup "$BASE/venv/bin/python" -m odoo -c "$BASE/odoo.conf" -d $DB > "$BASE/odoo.log" 2>&1 &
    echo $! > "$BASE/odoo.pid" ;;
  stop)   kill "$(cat "$BASE/odoo.pid")"; rm -f "$BASE/odoo.pid"; sleep 2; pg_ctl -D "$PGDATA" stop -m fast ;;
  status) pg_isready -p $PGPORT; lsof -nP -iTCP:$PORT -sTCP:LISTEN ;;
  log)    tail -n 40 "$BASE/odoo.log" ;;
esac
```

Een kopie van een back-up laad je geneutraliseerd (geen mail, geplande acties of betalingen) met
`python -m odoo db load --neutralize dig20-test <back-up.zip>`. Zet de map met jullie eigen modules (waar `svs` in zit)
in `--addons-path`, anders kan het dashboard de bezoeken niet lezen. Gebruik nooit de productiedatabase of
productiegegevens. Na een herstart van de computer moet de losse Postgres opnieuw worden gestart (`start` doet dat).

## 2. In Odoo: de gebruiker en de API-sleutel voor de gateway

Voor de eerste proef op een weggooi-database is de gebruiker `admin` genoeg: in Odoo 20 zit hij in
**Medewerkers: Beheerder** (`hr.group_hr_manager`, dat `hr.group_hr_user` omvat) en is hij actief, intern en van
het bedrijf. Voor de echte omgeving maak je een eigen gebruiker aan met **Medewerkers: Officer** (`hr.group_hr_user`) en
leesrechten op Planning en de DIG-bezoekformulieren, en zet je die ook niet op `admin`.

1. **API-sleutel:** klik rechtsboven op je avatar, kies je voorkeuren, tabblad Beveiliging, en maak een nieuwe API-sleutel.
   Kies bereik **RPC** (de JSON-2-API van Odoo 20 vraagt dat bereik) en een verlooptijd, bijvoorbeeld 1 maand.
   De sleutel zie je één keer. Kopieer hem en plak hem **niet** in een gesprek of document.
2. **Verantwoordelijke:** een actieve, interne gebruiker van het bedrijf, bij voorkeur Medewerkers: Officer. Voor de
   proef is dat `admin` (nummer `2`). Voor een andere gebruiker staat het nummer in de adresbalk als je hem opent.
3. **Bedrijf:** de lokale database heeft het bedrijf met nummer `1`.
4. Odoo 20 toont bovenaan "Deze database vervalt in 1 maand": dat is de melding van de Enterprise-proefperiode van een
   nieuwe database en geen fout.

## 3. Het dashboard en de gateway instellen

Doe dit **voordat** je de API-sleutel in Odoo aanmaakt, want het script schrijft het bestand waar de sleutel in moet:

```bash
bun run local:setup --odoo-url http://127.0.0.1:8071 --database dig20-test --company-id 1 --responsible-id 2
```

Het script toont één keer het adminwachtwoord (het staat daarna alleen als hash op schijf) en schrijft `.local/`.
Het script vraagt niet om de API-sleutel en schrijft hem nergens. Zet hem er zelf in, zonder hem te typen of te
plakken in een gesprek: kopieer de sleutel in Odoo (hij staat dan op het klembord van je Mac) en voer direct uit:

```bash
sed -i '' "s|^ODOO_API_KEY=.*|ODOO_API_KEY=$(pbpaste)|" .local/gateway.env
```

Kopieer niets anders voordat je dit doet. Draai `local:setup` opnieuw met `--force` voor een nieuw token en
wachtwoord. Het script weigert `*.odoo.sh` en `*.odoo.com`, net als de gateway. Zonder `--responsible-id` staat
"Monteur toevoegen" uit (en ook het wijzigen van planningsrollen). De planningsrollen kies je per monteur in het
dashboard uit de rollen die in Odoo staan (Planning, Configuratie, Rollen), bij het toevoegen en later via de knop
*Planningsrollen* bij Accounts: zonder rol kun je een monteur niet aan een dienst met een rol toewijzen.

## 4. Starten en controleren

```bash
bun run local:rehearsal start       # gateway en dashboard, op .local; start geen demo-Odoo en wijzigt .local niet
                                    # bouwt het dashboard zelf opnieuw als de code nieuwer is dan de laatste bouw (na een git pull)
bun run local:rehearsal logs gateway
curl -s http://127.0.0.1:8070/healthz
TOKEN=$(grep '^DIG_GATEWAY_TOKEN=' .local/dashboard.env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8070/v1/schema     # let op "missing"
```

`missing` in het schema noemt velden die wel in de allowlist staan maar niet in jouw database bestaan, en een model dat
er niet is (bijvoorbeeld `svs.tech.visit` zonder jullie eigen modules): zonder dat model kan het dashboard de
afspraken niet tonen, maar "Monteur toevoegen" werkt wel. Open `http://127.0.0.1:3000` en log in als `admin`.
`bun run local:rehearsal stop` stopt gateway en dashboard.

## 5. De proef

1. **Beheer, Monteur toevoegen**: naam `Proef Monteur`, de voorgestelde gebruikersnaam, en vink de rol(len) aan (bijvoorbeeld
   `monteur`; maak hem eerst in Odoo aan bij Planning, Configuratie, Rollen). Noteer het Odoo-nummer en het wachtwoord.
2. Controleer in Odoo (Medewerkers):
   - de medewerker bestaat, in het juiste bedrijf, met de juiste verantwoordelijke;
   - **Gerelateerde gebruiker is leeg**, en onder Instellingen, Gebruikers is er geen nieuwe gebruiker bij gekomen;
   - Odoo heeft zelf een werkcontact en een interne notitie in de chatter gemaakt (verwacht, zie `docs/accounts.md`);
   - er is geen planning of dienst aangemaakt.
3. **Planning:** maak een dienst met de rol `monteur` en wijs de nieuwe monteur eraan toe. Volgens de gebruiker werkt dat
   alleen als de medewerker die functie heeft; daarom kiest de planner de rollen bij het toevoegen. Of Odoo 20 de rollen in
   de aanmaak van het dashboard aanneemt is nog niet tegen een echte Odoo gezien: kijk bij de nieuwe medewerker in
   Werknemers of het veld *Functies* (Roles) is gevuld (en *Standaardrol* (Default Role): de eerste rol die je aanvinkte) en of hij te kiezen is
   bij de dienst. Het scherm van het dashboard zegt hoeveel rollen Odoo bevestigde.
   **Later wijzigen:** kies bij Accounts bij de monteur **Planningsrollen**, vink andere rollen aan of uit en kies **Opslaan
   in Odoo**. Controleer in Odoo (Werknemers, veld *Functies* (Roles)) dat de rollen kloppen en dat er geen Odoo-gebruiker bij is gekomen.
   Zie je een foutmelding, stuur me die dan: dit is het deel dat nog niet tegen een echte Odoo 20 is gezien.
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
