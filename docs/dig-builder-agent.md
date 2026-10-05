# DIG Builder agent (fase 2)

De agent past één app aan in een lokale git-checkout en levert het resultaat op als commit
op een eigen branch `builder/<run-id>`, plus een diff en een runlog. Hij pusht nooit en
werkt nooit op `main`/`master`. Code staat in `agent/` (Node 22+, `@anthropic-ai/sdk`, `zod`).

## Gebruik

```bash
cd agent && bun install
export ANTHROPIC_API_KEY=...                 # of een andere SDK-credentialbron
export DIG_GATEWAY_URL=http://odoo-gateway:8070 DIG_GATEWAY_TOKEN=...   # optioneel
node --experimental-strip-types src/cli.ts \
  --workdir ../../mijn-app \
  --task "Voeg een filter op monteur toe aan de weekplanning"
```

Opties: `--task-file`, `--run <id>`, `--out <map>` (standaard `.dig-builder-runs/`, moet buiten
de werkmap liggen), `--model` (standaard `claude-opus-5-5`), `--effort`
(`low|medium|high|xhigh|max`, standaard `high`), `--max-turns` (standaard 40),
`--max-cost-usd` (standaard 5; stopt vóór het volgende verzoek als de geschatte kosten de limiet bereiken, status `budget`), `--keep-branch`, `--sandbox` (installatie en alle checks in een container, zie
`docs/dig-builder-sandbox.md`), `--checks <json>` (eigen checks, `{"naam": ["commando", ...]}`; in `--sandbox`-modus wordt een `dig-checks.json` in het project automatisch gebruikt, zodat tests en build mee kunnen draaien; zonder sandbox alleen met een expliciete `--checks`).

Uitvoer in `<out>/<run-id>/`: `changes.diff` en `run.json` (status, beurten, tokengebruik,
branch, basis-commit, gewijzigde bestanden, samenvatting, tool-events zonder bestandsinhoud).
Exitcode 0 = klaar, 2 = gestopt zonder `done` (bijv. `max_turns`), 1 = afgebroken door een fout.

## Werking

1. Controleert dat de werkmap een schone git-tree heeft en maakt `builder/<run-id>` aan.
2. Bouwt de system-prompt: vaste instructies plus `RULES.md` (of `LEO_RULES.md`) van het
   project, als data gemarkeerd.
3. Loop met de Claude API (streaming): het model roept tools aan, de agent voert ze uit en
   stuurt alle resultaten van één beurt in één bericht terug, tot het model klaar is.
4. Commit alle wijzigingen op de run-branch en schrijft diff en runlog.

Tools: `list_files`, `read_file`, `write_file`, `edit_file` (precies één vervanging),
`run_check` (op naam) en, als de gateway is ingesteld, `odoo_schema` (alleen metadata).

Na een fallback midden in een antwoord worden `thinking`- en `tool_use`-blokken vóór de fallback niet teruggestuurd en hun tools niet uitgevoerd. `run.json` bevat `estimatedCostUsd` (schatting uit tokentellingen en lijstprijzen).

API-instellingen: model `claude-opus-5-5`, adaptief denken (standaard), `effort` instelbaar,
prompt caching op de vaste prefix, en server-side fallback (`fallbacks: "default"`) zodat een
weigering door een veiligheidsfilter automatisch op een ander model wordt herhaald.

## Veiligheidsgrenzen

- **Bestanden:** elk pad wordt binnen de werkmap opgelost, ook na het volgen van symlinks.
  `.git`, `node_modules`, build-uitvoer, `.env*` (behalve `.env.example`) en sleutel-/database-
  bestanden zijn niet lees- of schrijfbaar. Lezen max 256 KB, schrijven max 512 KB per bestand.
- **Tool-input:** wordt met zod gevalideerd voordat er iets gebeurt (de input streamt
  ongevalideerd binnen). Ongeldige input, onbekende tools en fouten gaan als foutresultaat
  terug naar het model. Bij `max_tokens` of `refusal` worden de tools van die beurt niet
  uitgevoerd.
- **Checks:** het model kiest alleen een naam. Standaard `typecheck` (`tsc --noEmit`) en
  `lint` (`oxlint` zonder `--fix`): die lezen de code maar voeren hem niet uit. Checks draaien
  met een kale omgeving (geen API-keys), een tijdelijke `HOME`, time-out 120 s en ingekorte
  uitvoer.
- **Git:** repository-hooks staan uit (`core.hooksPath=/dev/null`, `--no-verify`), git krijgt
  geen API-keys in de omgeving, branchnamen moeten `builder/...` zijn, en er wordt niet gepusht.
- **Odoo:** de agent ziet alleen het schema van de gateway (modellen, velden, types), nooit
  records of de Odoo-key. De instructies laten gegenereerde code Odoo alleen via de gateway lezen.

Gegenereerde mappen (`node_modules`, `dist`, `.output`, `.wrangler`, `.vite`, `coverage`)
komen nooit in de commit, ook niet als het project ze vergeten is te negeren; `run.json`
noemt ze onder `excluded`.

## Bewust nog niet

- Zonder `--sandbox` draait alles op de host en zijn alleen checks toegestaan die geen
  projectcode uitvoeren. Gebruik `--sandbox` voor builds en tests.
- Geen chat-UI en geen publicatie. De mens beoordeelt de diff en merget zelf.
- De kostenlimiet is een schatting uit tokentellingen en lijstprijzen; de factuur is leidend.

## Verificatie

- 27 tests (`bun run test:agent`): padbeveiliging incl. symlinks, edit-regels, checks
  (allowlist, kale omgeving, time-out), git (branchregels, vuile tree, hooks staan uit, master
  onaangeroerd), en de loop met een gescripte client (toolresultaten in één bericht,
  append-only geschiedenis, stabiele request-vorm, `max_tokens`/`refusal`/`pause_turn`,
  begrensde JSON-retry, maximaal aantal beurten).
- `tsc -p agent` en oxlint zonder meldingen.
- End-to-end: `cli.ts` met de echte SDK tegen een lokale nep-API (SSE-streaming) op een
  git-repo: branch, commit en diff kloppen; de requests bevatten de fallback-beta, effort en
  de projectregels.
- Niet uitgevoerd: een run tegen de echte Claude API (geen API-key in deze omgeving).
