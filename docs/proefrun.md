# Proefrun van de agent

Een eerste echte run van de DIG Builder-agent op het monteursdashboard, met de echte Claude API.
Tot nu toe is de agent alleen getest met een nagebootste API; deze run laat zien wat het echte model
met de prompt en de tools doet.

Er wordt **geen echte Odoo** gebruikt (een demo-Odoo met testgegevens draait lokaal), niets gepusht
en niets buiten de map `~/dig-proefrun` aangeraakt.

## Voorbereiding

- Een gewone gebruiker (niet root), met Node 22+, Bun, Git en bij voorkeur Docker.
- `ANTHROPIC_API_KEY` in je shell (niet in een bestand in de repo).
- Met Docker: `bun run sandbox:image` (eenmalig). Dan draaien installatie en alle checks, inclusief
  de build, in de sandbox. Zonder Docker beperkt het script zich tot typecheck en lint op de host.

## Starten

```bash
export ANTHROPIC_API_KEY=sk-ant-...
scripts/proefrun.sh alles
```

`alles` draait drie opdrachten na elkaar op een schone kopie van het dashboard, met een demo-Odoo vol lastige
testgegevens, en maakt aan het eind **één rapport** om terug te sturen. Je kunt ze ook los draaien:

| Naam | Opdracht | Waarom |
|---|---|---|
| `zoekveld` | Een zoekveld boven de lijst om op klantnaam of adres te filteren (in de browser, hoofdletterongevoelig, melding bij geen resultaat) | Kleine, frontend-gerichte wijziging |
| `kaart` | Een kaart met het aantal DIG-bezoeken per status voor de getoonde afspraken, alleen met gegevens die al worden opgehaald | Werkt met de gegevens en met onbekende statussen |
| `monteur` | Het monteursfilter werkt op naam, dus twee monteurs met dezelfde naam lopen door elkaar; laat het op een stabiel id werken | Echt ontwerpwerk: er zijn verschillende id's (medewerker, gebruiker) |

Of geef zelf een opdracht: `scripts/proefrun.sh "Als ... dan ..."`. (De eerdere opdracht over meerdere bezoeken per
afspraak is opgelost; zie `docs/proefrun-resultaten.md`.)

Elke run begint op `master` van de kopie. Standaard geldt per run een **kostenlimiet van $5** en maximaal 40
beurten; de run stopt zelf vóór het volgende verzoek als de schatting de limiet bereikt. Reken op ongeveer
$0.50 per opdracht, dus $1 tot $2 voor `alles`.

De agent heeft naast de checks (typecheck, lint, test, build) de tool `probe_app`: die bouwt de app, start hem op
de testgegevens van `scripts/demo-data.mjs` en geeft terug wat een aantal adressen opleveren, zodat hij ziet wat
zijn wijziging echt doet, ook bij lege velden, meerdere bezoeken per afspraak of een planning die niet geladen is.
Het toont serverantwoorden, geen scherm. De probe en de checks draaien in een container, of op je eigen computer
als je `PROEFRUN_HOST_TESTS=1` zet.

Zonder Docker draaien alleen `typecheck` en `lint`. Wil je dat de agent ook `test`, `build` en `probe_app` gebruikt
zonder Docker, zet dan `PROEFRUN_HOST_TESTS=1`: die draaien dan op je eigen computer, in de wegwerpkopie. Met Docker
(`bun run sandbox:image`) draaien ze altijd in een container.

Opties via omgevingsvariabelen: `PROEFRUN_MAX_COST`, `PROEFRUN_EFFORT` (`low` tot `max`, standaard `high`),
`PROEFRUN_MAX_TURNS`, `PROEFRUN_DIR`, `PROEFRUN_FRESH=1` (kopie opnieuw opbouwen), `PROEFRUN_HOST_TESTS=1`.

## Wat je terugstuurt

Het script noemt aan het eind één rapport, `~/dig-proefrun/rapport-<datum>.md`, met per opdracht de status, kosten,
gewijzigde bestanden, de checks en probe die de agent draaide, zijn samenvatting en de volledige diff. Kopieer het
naar je klembord en plak het hier (Cmd+V):

```bash
cat ~/dig-proefrun/rapport-*.md | pbcopy
```

(Heb je meerdere rapporten, kies dan het nieuwste: `cat "$(ls -t ~/dig-proefrun/rapport-*.md | head -1)" | pbcopy`.)
Er staan geen sleutels of echte klantgegevens in, alleen code en een logboek van de run.

## Waar ik naar kijk

- Leest de agent eerst (`RULES.md`, de relevante bestanden) of begint hij te raden?
- Gebruikt hij `odoo_schema` en blijft hij binnen de toegestane velden?
- Draait hij de checks en repareert hij wat ze melden? Hoeveel beurten kost dat?
- Gebruikt hij `probe_app` en kijkt hij echt naar de lastige gevallen in de gegevens, of alleen naar de gelukkige weg?
- Is de wijziging klein en gericht, of raakt hij ongerelateerde bestanden?
- Stopt hij zelf met een duidelijke samenvatting, of loopt hij tegen een limiet?
- Kosten per run, en of de `effort`-instelling bij de opdracht past.

Op basis daarvan pas ik de prompt, de tools en de limieten aan.

Eerdere resultaten staan in `docs/proefrun-resultaten.md`.

## Problemen

- `ANTHROPIC_API_KEY is niet ingesteld`: de sleutel moet in de shell staan waarin je het script start.
- `permission denied` op Docker: je gebruiker moet in de `docker`-groep zitten.
- Installatie in de sandbox mislukt achter een bedrijfsproxy met eigen certificaat: zet
  `DIG_SANDBOX_CA_BUNDLE=/pad/naar/ca.pem`.
- Status `budget`: de limiet is bereikt. Verhoog `PROEFRUN_MAX_COST` of splits de opdracht.
- Status `refusal`: een veiligheidsfilter heeft geweigerd en ook het fallback-model deed dat. Stuur
  `run.json` mee.
