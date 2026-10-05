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
