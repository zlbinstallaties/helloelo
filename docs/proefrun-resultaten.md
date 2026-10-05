# Resultaten van de proefruns

## Run 1: meerdere bezoeken per afspraak (2026-10-05)

Opdracht: "Als een afspraak meerdere DIG-bezoeken heeft, toont het dashboard er maar één. Laat alle
bezoeken van de afspraak zien in het detailpaneel." Model `claude-opus-5-5`, effort `high`, host-modus
(geen Docker), 10 beurten, geschatte kosten $0.35.

**Wat goed ging.** De agent las eerst de relevante bestanden en `odoo_schema`, wijzigde alleen drie
bestanden, draaide typecheck en lint zonder fouten en meldde zelf wat hij niet kon controleren (build,
echte data). Het detailpaneel toont nu alle bezoeken met eigen status, technicus, ontbrekende
onderdelen, foto's en Odoo-link; bij één bezoek blijft het oude uiterlijk.

**Wat ik vond door het resultaat te draaien met demodata (oud naast nieuw).**

1. **Fout: een bezoek verdween.** De nieuwe code telt elk bezoek dat via `slot_id` naar een planning
   verwijst als "ingepland", ook als die planning niet is geladen (bijvoorbeeld buiten de limiet van 500
   of gearchiveerd). Zo'n bezoek werd vroeger getoond als kaart "Niet gepland" en is nu helemaal weg.
   Typecheck en lint zien dit niet. De samenvatting zei "bezoeken die aan een *geladen* planning hangen",
   maar de code controleert dat niet: de samenvatting was dus stelliger dan de code.
2. **Gedrag buiten de opdracht.** De kaart "DIG-bezoeken" telt nu bezoeken in plaats van afspraken met
   een bezoek, en "ontbrekend verplicht" en "foto's" op de afspraakkaart zijn nu sommen over alle
   bezoeken. De agent noemde beide keuzes zelf, maar ze horen niet bij de gevraagde wijziging.

**Wat ik daarom heb aangepast.**

- De logica staat nu in `src/lib/appointments.ts` (zonder I/O) met 10 tests in
  `test/appointments.test.ts`, waaronder het geval van de planning die niet is geladen; die test faalt
  op de gewijzigde code van run 1.
- `dig-checks.json`: de sandbox kent nu ook de checks `build` en `test`. In host-modus draaien die niet
  (ze voeren projectcode uit), tenzij je `PROEFRUN_HOST_TESTS=1` zet.
- De instructies aan de agent: denk bij logica die data groepeert of koppelt na over records die niet
  passen (niet-geladen verwijzingen, lege waarden, dubbelen), voeg een test toe, en controleer vóór de
  samenvatting dat elke bewering in de code klopt.
- `RULES.md`: de plek van de logica en de tests, en dat een niet-beschikbare check in de samenvatting
  genoemd moet worden.

**Open.** Een tweede run met dezelfde opdracht, met tests aan, laat zien of de agent het geval nu zelf
vindt.

## Run 2: dezelfde opdracht, met tests en strengere instructies (2026-10-05)

Zelfde opdracht, `claude-opus-5-5`, effort `high`, host-modus met `PROEFRUN_HOST_TESTS=1`. 11 beurten, geschatte
kosten $0.49. Alle vier de checks draaiden: typecheck, lint, test (22) en build.

**Wat beter ging dan run 1.**

- De agent vond het geval van de niet-geladen planning zelf. De nieuwe functie `groupVisitsBySlot` koppelt een
  bezoek alleen aan een planning die echt geladen is; verwijst `slot_id` naar een niet-geladen planning, dan
  telt een planning die het bezoek zelf opsomt, en anders blijft het bezoek "Niet gepland".
- Hij schreef 7 nieuwe tests (meerdere bezoeken, koppeling via de lijst van de planning, dubbele records,
  niet-geladen bezoeken, lege lijst) en liet alle checks slagen.
- De samenvatting klopt met de code, ook op de punten die hij zelf als randgeval noemt, en benoemt wat hij niet
  heeft kunnen controleren (de draaiende app).

**Mijn controle (diff letterlijk toegepast op een schone kopie, demodata).**

- 22 van 22 tests, typecheck, lint en build slagen; mijn test van run 1 voor de niet-geladen planning slaagt nu.
- Een willekeurige controle over 5000 datasets (elke bezoek-id moet precies één keer op het scherm staan) slaagt;
  dezelfde controle faalt op de oorspronkelijke code.
- In de browser: "Alle" toont 6 kaarten en alle 5 bezoeken, TV/0005 staat weer als "Niet gepland" en
  "Mevrouw Peters" toont beide bezoeken met een eigen kaartje.

**Wat overblijft, en vooral een productkeuze is.**

1. **De status van de afspraak komt van het eerste bezoek (laagste id).** Bij "Mevrouw Peters" is TV/0002 afgerond
   en TV/0003 nog in uitvoering met 2 ontbrekende onderdelen; de kaart en het paneel tonen "Afgerond". Dat is
   misleidend en slechter dan vóór de wijziging (toen de laatste, openstaande). De agent noemde dit zelf als open
   punt. Voorstel: de status van het eerste bezoek dat nog niet afgerond is; pas als alle bezoeken klaar zijn
   "Afgerond".
2. **Opgetelde aantallen** ontbrekende onderdelen en foto's op de kaart en in het paneel, met "(totaal)".
3. **De teller "DIG-bezoeken"** telt nu bezoeken in plaats van afspraken met een bezoek.

Punt 2 en 3 zijn verdedigbaar en door de agent benoemd; punt 1 moet worden aangepast.

**Les voor het proces.** Een goede samenvatting en groene checks vervangen niet het draaien van het resultaat:
de status-inconsistentie en (bij run 1) de verdwenen bezoeken zijn alleen op het scherm of met een
invariant-test te zien. Een volgende stap is een vaste "draai het met demodata en kijk"-stap voor de agent.

**Overgenomen in het dashboard.** De diff van run 2 is ongewijzigd toegepast (eigen commit), gevolgd door twee
losse commits van mij: de statusregel (status van het eerste bezoek dat nog niet afgerond is; een test die op
de oorspronkelijke agent-versie faalt) en de test dat elk bezoek precies één keer op het scherm staat over 3000
willekeurige datasets. Punt 2 en 3 zijn zo gelaten.
