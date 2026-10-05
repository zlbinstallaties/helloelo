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
scripts/proefrun.sh "Als een afspraak meerdere DIG-bezoeken heeft, toont het dashboard er maar één. Laat alle bezoeken van de afspraak zien in het detailpaneel."
```

Het script zet een schone kopie van het dashboard klaar, start demo-Odoo en gateway, laat de agent
werken (met live voortgang) en toont het resultaat. Standaard geldt een **kostenlimiet van $5** en
maximaal 40 beurten; de run stopt zelf vóór het volgende verzoek als de schatting de limiet bereikt.
Reken op ongeveer $1 tot $3 voor een opdracht als hieronder, afhankelijk van hoeveel de agent leest.

Zonder Docker draaien alleen `typecheck` en `lint`. Wil je dat de agent ook `test` en `build` draait zonder Docker, zet dan
`PROEFRUN_HOST_TESTS=1`: die checks draaien dan op je eigen computer, in de wegwerpkopie. Met Docker (`bun run sandbox:image`)
draaien ze altijd in een container.

Opties via omgevingsvariabelen: `PROEFRUN_MAX_COST`, `PROEFRUN_EFFORT` (`low` tot `max`, standaard
`high`), `PROEFRUN_MAX_TURNS`, `PROEFRUN_DIR`, `PROEFRUN_FRESH=1` (kopie opnieuw opbouwen).

## Drie opdrachten, oplopend in moeilijkheid

1. **Klein, alleen frontend:** "Voeg boven de lijst een zoekveld toe om afspraken op klantnaam te filteren."
2. **Echte bug (meerdere bestanden):** de opdracht hierboven over meerdere bezoeken per afspraak.
   De demo-Odoo bevat een afspraak ("Storing vloerverwarming") met twee bezoeken, zodat het
   resultaat te controleren is.
3. **Gebruikt de Odoo-gegevens:** "Voeg een kaart toe met het aantal bezoeken per status. Gebruik
   alleen velden die de gateway toestaat." Hier hoort de agent `odoo_schema` te raadplegen.

Doe ze liefst alle drie, na elkaar; elke run begint opnieuw op `master` van de kopie.

## Wat je terugstuurt

Na afloop noemt het script twee bestanden in `~/dig-proefrun/runs/<run-id>/`:

- `run.json`: status, beurten, tokengebruik, geschatte kosten, gewijzigde bestanden, de samenvatting
  van de agent en de volgorde van tools.
- `changes.diff`: de wijzigingen.

Stuur die twee (per opdracht) terug. Ze bevatten geen sleutels of gegevens uit een echte Odoo.
Je kunt de wijziging ook zelf bekijken: `git -C ~/dig-proefrun/dashboard log --oneline` en
`bun run dev` in die map.

## Waar ik naar kijk

- Leest de agent eerst (`RULES.md`, de relevante bestanden) of begint hij te raden?
- Gebruikt hij `odoo_schema` en blijft hij binnen de toegestane velden?
- Draait hij de checks en repareert hij wat ze melden? Hoeveel beurten kost dat?
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
