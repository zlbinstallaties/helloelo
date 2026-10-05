# Projectregels: DIG Monteursdashboard

- Alle teksten die gebruikers zien zijn Nederlands. Datums en tijden worden getoond in `Europe/Amsterdam`.
- Stack: TanStack Start (SSR op Node), React 19, Tailwind 4 en shadcn/ui-componenten in `src/components/ui`.
  Hergebruik die componenten; voeg geen nieuwe UI-bibliotheken toe.
- Odoo wordt alleen gelezen, uitsluitend via `src/lib/gateway.server.ts` (`searchRead`). Geen directe
  Odoo-aanroepen en geen schrijfacties. De gateway staat alleen de velden toe die `odoo_schema` laat zien;
  een nieuw veld voeg je toe aan de lijst in `src/lib/cache.ts` en aan de types in `src/lib/dashboard-types.ts`.
- Geen geheimen, tokens of sleutels in bestanden. Servercode leest ze uit `process.env`. Bestanden die
  `*.server.ts` heten worden nooit vanuit clientcode geïmporteerd.
- Routes staan in `src/routes` (bestandsgebaseerd). `src/routeTree.gen.ts` wordt gegenereerd door de build;
  bewerk dat bestand niet met de hand.
- Bestaand gedrag blijft werken: cache van 5 minuten, periodes dag/komend/alle, filter op monteur,
  het detailpaneel en de vernieuwknop.
- De logica die Odoo-gegevens omzet naar afspraken staat in `src/lib/appointments.ts` (zonder I/O) met tests in
  `test/appointments.test.ts`. Pas je die logica aan, werk dan de tests bij of voeg tests toe, ook voor
  randgevallen zoals een bezoek dat naar een niet-geladen planning verwijst.
- Je bent pas klaar als alle beschikbare checks slagen (`typecheck`, `lint` en, als ze beschikbaar zijn,
  `build` en `test`). Is een check niet beschikbaar, zeg dat dan in je samenvatting.
