# DIG Builder sandbox en previews (fase 3)

`sandbox/` voert projectcode uit in wegwerpcontainers in plaats van op de server zelf, en
toont per project een live preview achter een login. Geen npm-dependencies (Node 22+),
wel Docker.

## Onderdelen

| Bestand | Doel |
|---|---|
| `sandbox/Dockerfile` | Image `dig-sandbox:1`: Node 22 + Bun, gebruiker `node`, geen credentials |
| `sandbox/src/sandbox.ts` | Geharde `docker run`, `exec` (één commando) en `install` |
| `sandbox/src/preview.ts` | Eén preview-container per project op een intern netwerk, opruimen na inactiviteit |
| `sandbox/src/proxy.ts` | Reverse proxy met login, inclusief WebSockets (Vite HMR) |
| `sandbox/src/auth.ts` | scrypt-wachtwoordhash, ondertekende sessiecookie, rem op inlogpogingen |
| `sandbox/src/main.ts` | Start de preview-proxy |

## Wat elke container krijgt (en niet krijgt)

- Alleen de projectmap op `/work`; verder niets van de host. Geen Docker-socket.
- Draait als eigenaar van de projectmap, nooit als root (een map van root wordt geweigerd).
- Root-bestandssysteem alleen-lezen, `/tmp` als tmpfs, alle capabilities weg,
  `no-new-privileges`, `--init`, limieten op geheugen (zonder swap), CPU en processen.
- Omgeving: alleen `HOME=/tmp`, `CI=1`, `NO_COLOR=1` plus wat expliciet wordt meegegeven.
  Namen met `KEY`, `SECRET`, `TOKEN`, `PASSWORD` of `CREDENTIAL` worden geweigerd, behalve
  `DIG_GATEWAY_TOKEN` (het beperkte gateway-token voor previews). De Odoo-key en de
  Anthropic-key komen er nooit in.
- Netwerk per stap:
  - `install`: bridge (registry nodig), maar `bun install --frozen-lockfile --ignore-scripts`,
    dus er draait geen code uit de gedownloade pakketten.
  - checks/build/tests: `none`.
  - preview: een **intern** Docker-netwerk (`dig-preview`), dus geen internet. Hang de
    Odoo-gateway aan dat netwerk om previews Odoo-data te laten lezen:
    `docker network connect dig-preview <gateway-container>`.

## Agent met sandbox

```bash
bun run sandbox:image                       # eenmalig
node --experimental-strip-types agent/src/cli.ts --workdir <app> --task "..." --sandbox
```

De agent installeert eerst de dependencies in de sandbox en voert daarna elke check in een
nieuwe container zonder netwerk uit: `typecheck`, `lint` en `build` (`vite build`). Eigen
checks (bijv. tests) met `--checks checks.json`.

## Previews

```bash
bun run preview:password '<wachtwoord van minstens 12 tekens>'   # hash + sessiegeheim
cp sandbox/previews.example.json sandbox/previews.json            # projecten invullen
PREVIEW_DOMAIN=preview.example.com PREVIEW_PASSWORD_HASH=... PREVIEW_SESSION_SECRET=... \
PREVIEW_PROJECTS_FILE=sandbox/previews.json bun run preview:start
```

- Project `x` staat op `https://x.preview.example.com`. Zet er een TLS-proxy met een
  wildcardcertificaat voor (bijv. Caddy of Traefik) die naar poort 8090 doorstuurt.
- Eerste bezoek: inlogpagina. Daarna een cookie (`HttpOnly`, `Secure`, `SameSite=Lax`,
  geldig voor alle previews onder het domein, 12 uur). De app zelf ziet die cookie niet.
- Het eerste verzoek start de container (`vite dev`); tot de dev-server luistert, krijgt
  de bezoeker een pagina die zichzelf ververst. Na 30 minuten zonder verzoeken stopt de
  preview (`PREVIEW_IDLE_MINUTES`).
- Na 10 foute wachtwoorden binnen 15 minuten wordt een IP-adres tijdelijk geweigerd.
- WebSockets (HMR) alleen met geldige sessie én een `Origin` die gelijk is aan de
  preview-host; dat blokkeert cross-site WebSocket-kaping met de cookie van de gebruiker.
  Geweigerde upgrades worden gelogd.

**Let op:** de preview-proxy zelf heeft toegang tot Docker nodig om containers te starten.
Dat is gelijk aan root op de server. Draai hem daarom als aparte systeemdienst op de
builder-server, niet in een container met de Docker-socket, en laat alleen de TLS-proxy
ervoor publiek bereikbaar zijn.

## Verificatie

Uitgevoerd in de ontwikkelomgeving met een echte Docker-daemon:

- 16 unit-tests (`bun run test:sandbox`): containerflags, weigeren van root, secrets en
  rare mounts, time-out ruimt de container op, CA alleen bij installatie; wachtwoord,
  sessies, rem op inlogpogingen; proxy-login, open-redirect, cookie-scoping, Host-herschrijving,
  sessiecookie verwijderd, 404/503, WebSocket-tunnel.
- 3 integratietests tegen Docker: uid 1000, alleen-lezen root, schrijfbare `/work`, geen
  netwerk, geen host-secrets; time-out verwijdert de container; preview op intern netwerk
  wordt bereikbaar, heeft geen internet en wordt opgeruimd.
- End-to-end: agent met `--sandbox` op een Vite-project (installatie en `vite build` in de
  sandbox, commit bevat alleen `src/`), en de preview-proxy met `vite dev` in een container:
  login, pagina en modules via de proxy, HMR-WebSocket `101 Switching Protocols`.
- In Chromium (Playwright): inlogscherm, fout wachtwoord, startscherm, preview, en een
  wijziging in de broncode die zonder handmatig verversen in de browser verschijnt.
- Niet uitgevoerd: preview van het monteursdashboard zelf (dat leunt nog op HelloLeo en de
  Cloudflare-runtime), TLS-proxy ervoor, en een run tegen de echte Claude API.

## Nog niet

- Eén gedeeld previewwachtwoord; geen gebruikers of rollen (fase 4: login via Odoo).
- Geen chat-UI om runs te starten; runs gaan via de CLI.
- Geen limiet op schijfgebruik per container (Docker-storage-quota hangt af van de host).
