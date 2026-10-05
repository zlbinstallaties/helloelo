#!/usr/bin/env bash
# Proefrun van de DIG Builder-agent op het monteursdashboard.
#
#   ANTHROPIC_API_KEY=sk-ant-... scripts/proefrun.sh "<opdracht>"
#
# Zet een schone kopie van het dashboard klaar, start een demo-Odoo en de gateway
# lokaal, laat de agent de opdracht uitvoeren en toont het resultaat. Er wordt niets
# gepusht en er wordt geen echte Odoo gebruikt.
#
# Optioneel: PROEFRUN_DIR (standaard ~/dig-proefrun), PROEFRUN_MAX_COST (USD, standaard 5),
#            PROEFRUN_FRESH=1 (kopie opnieuw opbouwen), PROEFRUN_EFFORT (standaard high),
#            PROEFRUN_MAX_TURNS (standaard 40), DIG_SANDBOX_CA_BUNDLE (achter een TLS-proxy).
set -euo pipefail

TASK="${1:-}"
if [ -z "$TASK" ]; then
  echo "gebruik: scripts/proefrun.sh \"<opdracht>\"   (voorbeelden: docs/proefrun.md)" >&2
  exit 1
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
  echo "ANTHROPIC_API_KEY is niet ingesteld. Zet hem in je shell, niet in een bestand in de repo." >&2
  exit 1
fi
case "${ANTHROPIC_API_KEY:-}" in
  *...) echo "ANTHROPIC_API_KEY is nog het voorbeeld (sk-ant-...). Zet je echte sleutel erin." >&2; exit 1 ;;
esac
if [ "$(id -u)" = "0" ]; then
  echo "Draai dit als gewone gebruiker, niet als root: de sandbox draait nooit als root." >&2
  exit 1
fi
need() { command -v "$1" >/dev/null || { echo "$1 ontbreekt. $2" >&2; exit 1; }; }
need node "Installeer Node 22 of nieuwer via https://nodejs.org (de LTS-versie) en open Terminal opnieuw."
need bun "Installeer met: curl -fsSL https://bun.sh/install | bash   en open Terminal daarna opnieuw."
need git "Installeer Git (op een Mac: xcode-select --install)."
need tar "tar ontbreekt."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node 22 of nieuwer is nodig (nu: $(node --version)). Installeer de LTS-versie via https://nodejs.org" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${PROEFRUN_DIR:-$HOME/dig-proefrun}"
APP="$WORK/dashboard"
RUNS="$WORK/runs"
MAX_COST="${PROEFRUN_MAX_COST:-5}"
mkdir -p "$WORK" "$RUNS"

# 1. Schone kopie van alleen het dashboard (zonder builder, gateway, sandbox en docs).
if [ "${PROEFRUN_FRESH:-}" = "1" ] && [ -d "$APP" ]; then rm -rf "$APP"; fi
if [ ! -d "$APP/.git" ]; then
  echo "== dashboard-kopie klaarzetten in $APP"
  mkdir -p "$APP"
  (cd "$REPO" && git ls-files -z -- . \
    ':!agent' ':!sandbox' ':!gateway' ':!docs' ':!builder' ':!deploy' \
    ':!docker-compose*.yml' ':!scripts/proefrun.sh' ':!scripts/demo-odoo.mjs' \
    ':!scripts/test-odoo-client.mjs' ':!scripts/run-dig-builder-integration.sh' ':!src/lib/odoo-client.ts' ':!.env.example' ':!README.md' \
    | tar --null -T - -cf - | tar -xf - -C "$APP")
  node -e '
    const fs = require("fs"), p = process.argv[1] + "/package.json", d = JSON.parse(fs.readFileSync(p, "utf8"))
    const keep = ["dev", "build", "start", "preview", "generate-routes", "typecheck", "lint", "test:app"]
    d.scripts = Object.fromEntries(Object.entries(d.scripts).filter(([k]) => keep.includes(k)))
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n")' "$APP"
  git -C "$APP" init -q -b master
  git -C "$APP" add -A
  git -C "$APP" -c user.name=proefrun -c user.email=proefrun@localhost commit -q -m "Dashboard voor proefrun"
fi
# Elke run begint op master, niet op de branch van een eerdere run.
git -C "$APP" checkout -q master
git -C "$APP" clean -fdq
if [ -n "$(git -C "$APP" status --porcelain)" ]; then
  echo "de dashboard-kopie heeft wijzigingen op master; gebruik PROEFRUN_FRESH=1" >&2
  exit 1
fi

# 2. Dependencies: in de sandbox als Docker en de image er zijn, anders op de host.
SANDBOX=""
if command -v docker >/dev/null && docker image inspect dig-sandbox:1 >/dev/null 2>&1; then
  SANDBOX="--sandbox"
  echo "== dependencies installeren in de sandbox"
  (cd "$REPO" && node --experimental-strip-types --no-warnings sandbox/src/cli.ts install "$APP" | tail -2)
else
  echo "== LET OP: geen Docker of geen sandbox-image (bun run sandbox:image); dependencies op de host,"
  echo "   checks beperkt tot typecheck en lint, geen build."
  (cd "$APP" && bun install --ignore-scripts | tail -2)
fi
(cd "$REPO/agent" && bun install --frozen-lockfile | tail -1)

# 3. Demo-Odoo en gateway op losse poorten, opgeruimd bij afsluiten.
PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT
TOKEN="proef-$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
HASH="$(printf %s "$TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(require("crypto").createHash("sha256").update(s).digest("hex")))')"
sed "s/0\{64\}/$HASH/" "$REPO/gateway/projects.example.json" > "$WORK/gateway-projects.json"
DEMO_PORT=$((20000 + RANDOM % 5000)); GW_PORT=$((DEMO_PORT + 1))
DEMO_ODOO_PORT=$DEMO_PORT node "$REPO/scripts/demo-odoo.mjs" 2>"$WORK/demo-odoo.log" & PIDS+=($!)
ODOO_BASE_URL="http://localhost:$DEMO_PORT" ODOO_API_KEY=demo ODOO_ALLOWED_HOSTS=localhost \
  GATEWAY_PROJECTS_FILE="$WORK/gateway-projects.json" GATEWAY_PORT=$GW_PORT \
  node --experimental-strip-types --no-warnings "$REPO/gateway/src/main.ts" >"$WORK/gateway.log" 2>&1 & PIDS+=($!)
sleep 1.5

# 4. De agent.
echo "== agent starten (limiet: \$$MAX_COST, ${PROEFRUN_MAX_TURNS:-40} beurten)"
set +e
DIG_GATEWAY_URL="http://127.0.0.1:$GW_PORT" DIG_GATEWAY_TOKEN="$TOKEN" \
  node --experimental-strip-types --no-warnings "$REPO/agent/src/cli.ts" \
  --workdir "$APP" --task "$TASK" --out "$RUNS" $SANDBOX \
  --max-cost-usd "$MAX_COST" --effort "${PROEFRUN_EFFORT:-high}" --max-turns "${PROEFRUN_MAX_TURNS:-40}" \
  --keep-branch
STATUS=$?
set -e

LATEST="$(ls -1t "$RUNS" | head -1 || true)"
echo
echo "== klaar (exitcode $STATUS)"
if [ -n "$LATEST" ]; then
  echo "Stuur deze twee bestanden terug om het resultaat te laten beoordelen:"
  echo "  $RUNS/$LATEST/run.json"
  echo "  $RUNS/$LATEST/changes.diff"
  echo "De wijzigingen staan op de branch in $APP (git -C $APP log --oneline)."
fi
exit "$STATUS"
