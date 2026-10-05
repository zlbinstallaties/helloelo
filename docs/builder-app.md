# Builder-app: opdrachten geven en wijzigingen beoordelen (fase 4)

Het scherm waarmee een medewerker de bouwagent aanstuurt, zonder terminal:

1. Inloggen met het builder-wachtwoord.
2. Een project kiezen en beschrijven wat er moet gebeuren (met "hoe grondig" en een kostenlimiet).
3. De voortgang live volgen (welk bestand de agent leest, wijzigt, welke check hij draait).
4. Het resultaat lezen: samenvatting van de agent, gewijzigde bestanden en de diff.
5. **Goedkeuren** (de branch wordt samengevoegd in de hoofdbranch van het project) of **afwijzen**
   (de branch wordt verwijderd). Zonder besluit verandert er niets aan de hoofdbranch.

De agent werkt altijd op een eigen branch `builder/<run-id>` en pusht nooit. De app voegt alleen
samen in het lokale checkout op de server; naar GitHub of Odoo gaat niets.

## Onderdelen

| Bestand | Rol |
|---|---|
| `builder-app/src/config.ts` | Projectenbestand inlezen en controleren (`parseProjects`). Tokens staan nooit in het bestand: `gatewayTokenEnv` noemt de omgevingsvariabele. |
| `builder-app/src/store.ts` | Bestandsopslag per run: `meta.json`, `events.jsonl`, `changes.diff`, `run.json` onder `BUILDER_APP_DATA_DIR/runs/<id>/`. |
| `builder-app/src/runs.ts` | Starten, volgen, stoppen, goedkeuren, afwijzen en herstellen na een herstart. Gebruikt `executeRun` uit `agent/src/run.ts`. |
| `builder-app/src/server.ts` | HTTP-API, sessies, static bestanden met strikte CSP. |
| `builder-app/public/` | De interface (gewone JavaScript, geen build-stap). `lib.js` bevat de pure hulpfuncties die in Node getest worden. |

## Gedrag dat je moet kennen

- **Eén run tegelijk per project**, en een globale grens (`BUILDER_APP_MAX_RUNS`, standaard 2): elke
  run kost geld.
- Na een run staat het checkout weer op de hoofdbranch. Een mislukte run laat geen losse wijzigingen
  achter: wat de agent al gedaan had wordt als work-in-progress vastgelegd op zijn eigen branch.
- **Goedkeuren** doet `git merge --no-ff` en ruimt de branch op. Geeft de merge een conflict (de hoofdbranch
  is intussen veranderd), dan wordt hij afgebroken en blijft de branch staan; de melding zegt dat je de
  opdracht opnieuw moet starten. Je kunt de oude run daarna afwijzen.
- Een run zonder wijzigingen toont "De agent heeft niets gewijzigd" en een knop **Opruimen**.
- Na een herstart van de server worden runs die nog "bezig" waren als mislukt gemarkeerd.
- De samenvatting van de agent is tekst die de agent zelf schrijft: lees de diff, vertrouw niet
  blind op "alle checks zijn groen".

## Beveiliging

- Wachtwoord wordt als scrypt-hash opgeslagen (`bun run preview:password`); sessiecookie is
  HMAC-getekend, `HttpOnly`, `Secure` en `SameSite=Strict`. Inlogpogingen worden beperkt per IP.
- Elke POST vereist de header `X-Dig-Builder: 1` én een Origin van dezelfde site (tegen CSRF).
- CSP: `script-src 'self'`, geen inline scripts of stijlen; agent-tekst wordt nooit als HTML
  weergegeven (eigen kleine markdown-parser die alleen tekstnodes maakt).
- Luistert standaard op `127.0.0.1`; op de server op het docker-bridgeadres achter Caddy
  (`deploy/dig-builder-app.service`).
- Het ene gedeelde wachtwoord is tijdelijk; login via Odoo-gebruikers is de volgende stap.

## Lokaal proberen

```bash
cp builder-app/projects.example.json /tmp/builder-projects.json   # workdir: een git-checkout van de app
node --experimental-strip-types --no-warnings sandbox/src/hash-password.ts 'een-wachtwoord-van-12+'
BUILDER_APP_PROJECTS_FILE=/tmp/builder-projects.json BUILDER_APP_DATA_DIR=/tmp/builder-data \
BUILDER_APP_PASSWORD_HASH='...' BUILDER_APP_SESSION_SECRET='...' BUILDER_APP_SECURE_COOKIES=false \
ANTHROPIC_API_KEY=... bun run builder:start      # http://127.0.0.1:8100
```

Zet in het projectenbestand `"sandbox": false` als Docker lokaal niet draait; dan wordt er niets
geïnstalleerd en alleen de checks zonder afhankelijkheden uitgevoerd.

## Tests

`bun run test:builder-app` en `bun run typecheck:builder-app`. De tests starten echte
git-repositories en de echte HTTP-server met een nep-agent. De interface is daarnaast met een
echte browser doorlopen (inloggen, starten, live voortgang, goedkeuren, stoppen, afwijzen, mobiel)
met een nagebootste Claude-API; dat is nog niet met een echte API-sleutel gebeurd.

## API (voor wie hem wil aanroepen)

| Route | Betekenis |
|---|---|
| `GET /api/session`, `POST /api/login`, `POST /api/logout` | sessie |
| `GET /api/projects` | projecten (zonder paden en tokens) |
| `POST /api/projects/:id/runs` | `{task, effort?, maxCostUsd?}` → run starten (201) |
| `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/diff` | overzicht, detail, diff |
| `GET /api/runs/:id/events` | Server-Sent Events: eerdere gebeurtenissen, daarna live |
| `POST /api/runs/:id/stop`, `/approve`, `/reject` | besluiten |
