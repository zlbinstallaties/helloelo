# DIG Builder installeren op de Hostinger-VPS

> **Nieuw:** voor de VPS met de Odoo-testserver is er een installatiescript dat dit allemaal doet en de bestaande Caddy
> respecteert: zie `docs/dig-builder-install.md`. Dit document beschrijft de handmatige route voor een server zonder eigen
> webserver.

Zo komen de gateway, de sandbox en de previews op een eigen server. Dit is nog **niet** op een
echte server uitgevoerd: ik heb geen toegang tot de VPS. De losse onderdelen zijn wel getest
(zie `docs/odoo-gateway.md`, `docs/dig-builder-sandbox.md`); de Caddy-configuratie en de
compose-file zijn gevalideerd, de certificaataanvraag zelf niet.

## Wat hier nooit gebeurt

- **De productie-Odoo op Odoo.sh en de bijbehorende repository worden niet aangeraakt.** De
  gateway start niet als `ODOO_BASE_URL` niet in `ODOO_ALLOWED_HOSTS` staat, en hosts onder
  `*.odoo.sh` en `*.odoo.com` worden altijd geweigerd, ook als je ze toevoegt. De agent werkt
  alleen in checkouts van app-repositories op `builder/...`-branches en pusht nooit.
- Gebruik voor de gateway een aparte Odoo-gebruiker met alleen leesrechten op de **testomgeving**.

## Eerst controleren

1. **Poorten 80 en 443.** De Odoo-testserver draait op dezelfde VPS en gebruikt die poorten
   waarschijnlijk al (nginx, Traefik of Caddy). Controleer: `ss -ltnp | grep -E ':(80|443)\b'`.
   Zijn ze bezet, dan kan de TLS-front hieronder er niet bij. Kies dan: (a) de bestaande
   reverse proxy een extra host laten doorsturen naar `172.17.0.1:8090`, of (b) de builder op
   een eigen VPS zetten. Dit hoort bij elkaar besloten te worden vóór je verdergaat.
2. **Geheugen.** Builds draaien in containers met 2 GB; reken op minstens 4 GB vrij naast Odoo.
3. **Domein.** Een wildcard-DNS-record: `*.apps.<jouw-domein>` → IP van de VPS. Previews staan
   op `<project>.apps.<jouw-domein>`.

## Installeren

```bash
# Firewall (ook in het Hostinger-paneel): alleen 22, 80 en 443 open. Poort 8090 niet.
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable

# Docker, Node 22 en Bun
curl -fsSL https://get.docker.com | sh
# Node 22 en Bun volgens de documentatie van je distributie

useradd --system --create-home --shell /usr/sbin/nologin --groups docker dig-builder
install -d -o dig-builder /srv/dig-builder /srv/dig-builder/apps /etc/dig-builder
git clone https://github.com/zlbinstallaties/helloelo /srv/dig-builder/app
cd /srv/dig-builder/app && bun install
bun run sandbox:image                     # eenmalig
docker network create --internal dig-preview
```

### Gateway

```bash
cd /srv/dig-builder/app
bun run gateway:token                     # token voor het dashboard + sha256 voor de config
cp gateway/projects.example.json /etc/dig-builder/gateway-projects.json   # hash invullen
cp deploy/env.example /etc/dig-builder/stack.env && chmod 600 /etc/dig-builder/stack.env
# vul in: ACME_EMAIL, ODOO_API_KEY (alleen-lezen testgebruiker), ODOO_ALLOWED_HOSTS
```

### Een app als preview

```bash
git clone <app-repo> /srv/dig-builder/apps/dashboard
bun run sandbox:run install /srv/dig-builder/apps/dashboard
bun run preview:password '<wachtwoord van minstens 12 tekens>'   # hash + sessiegeheim
```

`/etc/dig-builder/previews.json` (zie `sandbox/previews.example.json`):

```json
{ "projects": [ { "id": "dashboard", "workdir": "/srv/dig-builder/apps/dashboard",
    "command": ["node_modules/.bin/vite", "dev"],
    "env": { "DIG_GATEWAY_URL": "http://odoo-gateway:8070", "DIG_GATEWAY_TOKEN": "<token>" } } ] }
```

`/etc/dig-builder/preview.env` (chmod 600): `PREVIEW_DOMAIN`, `PREVIEW_PASSWORD_HASH`,
`PREVIEW_SESSION_SECRET`, `PREVIEW_PROJECTS_FILE=/etc/dig-builder/previews.json`,
`PREVIEW_NETWORK=dig-preview` (zie `deploy/env.example`).

### Starten

```bash
cp deploy/dig-preview.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now dig-preview
docker compose -f deploy/docker-compose.yml --env-file /etc/dig-builder/stack.env up -d --build
```

Controle: `https://dashboard.apps.<jouw-domein>` toont de inlogpagina. Het eerste bezoek duurt een
paar seconden: Caddy vraagt dan het certificaat aan, en de preview-container start.

### De builder-app (opdrachten geven en beoordelen)

De builder-app is het scherm waar je een opdracht typt, de voortgang ziet, de wijzigingen leest en
goedkeurt of afwijst (`docs/builder-app.md`). Ze draait net als de preview-proxy als systemd-service.

```bash
cp builder-app/projects.example.json /etc/dig-builder/builder-projects.json   # pas aan
bun run preview:password '<ander wachtwoord van minstens 12 tekens>'          # hash + sessiegeheim
# vul /etc/dig-builder/builder-app.env (zie deploy/env.example), chmod 600
cp deploy/dig-builder-app.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now dig-builder-app
# BUILDER_DOMAIN in stack.env zetten en Caddy opnieuw laden:
docker compose -f deploy/docker-compose.yml --env-file /etc/dig-builder/stack.env up -d
```

Controle: `https://<BUILDER_DOMAIN>` toont de inlogpagina; `curl http://<publiek-ip>:8100` werkt niet.

**Publiceren** (vaste versie van een app voor de gebruikers): zet in `builder-projects.json` een
`publish`-blok per project (zie `docs/builder-app.md`), en gebruik voor beide diensten dezelfde
releasemap:

```bash
mkdir -p /srv/dig-builder/releases && chown dig-builder: /srv/dig-builder/releases
# builder-app.env:  BUILDER_APP_RELEASES_DIR=/srv/dig-builder/releases  en het token van de live app
# preview.env:      PREVIEW_RELEASES_DIR=/srv/dig-builder/releases
systemctl restart dig-preview dig-builder-app
```

De live app staat dan op `https://<project>-live.apps.<jouw-domein>` (zelfde wildcard-DNS, zelfde
inlog als de preview; Caddy vraagt het certificaat aan zodra er iets gepubliceerd is). Maak voor
de live app een apart gateway-token met alleen de rechten die hij nodig heeft.

## De agent op de server

```bash
cd /srv/dig-builder/app/agent && bun install
export ANTHROPIC_API_KEY=...               # in een eigen env-bestand, niet in git
export DIG_GATEWAY_URL=http://odoo-gateway:8070 DIG_GATEWAY_TOKEN=...
node --experimental-strip-types src/cli.ts --workdir /srv/dig-builder/apps/dashboard \
  --task "..." --sandbox
```

Het resultaat is een commit op `builder/<run-id>` plus `changes.diff` en `run.json`. Een mens
beoordeelt de diff en merget zelf.

## Beveiligingspunten

- De preview-proxy heeft Docker-rechten nodig, gelijk aan root op de server. Zet daarom niets
  anders op deze machine dat gevoelig is, en laat alleen 22/80/443 open.
- De proxy luistert op het docker-bridgeadres (`172.17.0.1`), dus alleen containers (de Caddy-
  front) bereiken hem. Controleer na installatie dat `curl http://<publiek-ip>:8090` niet werkt.
- Previews hebben geen internet en zien alleen de gateway op het interne netwerk `dig-preview`.
- Het ene gedeelde previewwachtwoord is tijdelijk; echte gebruikers (login via Odoo) is de
  volgende stap.

## Wat nog niet is gebouwd

- Login via Odoo-gebruikers in plaats van één gedeeld wachtwoord.
- De builder-app kent opdrachten, vervolgopdrachten, voortgang, diff, goedkeuren/afwijzen en publiceren.
  Een vrij gesprek met de agent (vragen stellen over de code zonder iets te wijzigen) volgt later.
