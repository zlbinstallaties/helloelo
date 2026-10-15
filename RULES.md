# Projectregels: DIG Monteursdashboard

- Alle teksten die gebruikers zien zijn Nederlands. Datums en tijden worden getoond in `Europe/Amsterdam`.
- Stack: TanStack Start (SSR op Node), React 19, Tailwind 4 en shadcn/ui-componenten in `src/components/ui`.
  Hergebruik die componenten; voeg geen nieuwe UI-bibliotheken toe.
- Odoo wordt gelezen via `src/lib/gateway.server.ts` (`searchRead`, `searchReadAll`). Geen directe Odoo-aanroepen.
  De gateway staat alleen de velden toe die `odoo_schema` laat zien; een nieuw veld voeg je toe aan de lijst in
  `src/lib/cache.ts` en aan de types in `src/lib/dashboard-types.ts`.
- Er zijn **vier** schrijfacties naar Odoo. Elk is een vaste, smalle gateway-actie die standaard uit staat en alleen
  aangaat als het projectconfig van de gateway erom vraagt:
  1. een planner voegt een monteur toe als medewerker in Odoo, zonder Odoo-account (`src/lib/employee-service.ts`,
     `gateway-employee.ts`, `admin-handlers.ts`, in de gateway `gateway/src/actions.ts`; `docs/accounts.md`);
  2. een planner wijzigt achteraf de planningsrollen van zo'n monteur (zelfde bestanden; `docs/planning-weigeren.md` en
     `docs/accounts.md`);
  3. een monteur geeft door dat hij niet beschikbaar is: één record per periode, geen dienst of planning
     (`src/lib/availability-handlers.ts`, `gateway-employee.ts`; `docs/beschikbaarheid.md`);
  4. een monteur of planner verstuurt een getekend schouw- of opleverdocument: één PDF als bijlage plus een interne
     notitie zonder ontvangers op de klant van de afspraak (`src/lib/document-handlers.ts`, `gateway-document.ts`,
     `document-journal.ts`; `docs/documenten.md`).
  Voeg geen andere schrijfacties toe, en wijzig, kopieer of verbreed deze niet: wat er naar Odoo gaat, wie het mag, het
  journaal en de volgorde zijn met opzet vast. Een nieuwe schrijfactie hoort bij een opdracht die daar expliciet over
  gaat en door een mens wordt beoordeeld.
- Inloggen en rechten (`src/lib/accounts.ts`, `auth.ts`, `authorization.ts`, `sessions.ts`, `password.ts`,
  `handlers.ts`, `admin-handlers.ts`, `availability-handlers.ts`, `document-handlers.ts`) wijzig je alleen als de opdracht daarover gaat. Elke route gaat via de handlers
  in `src/lib/handlers.ts`; maak geen route die daar omheen gaat, en laat een monteur nooit meer zien dan zijn eigen
  afspraken. `DIG_AUTH=off` is alleen voor previews en ontwikkeling.
- Geen geheimen, tokens of sleutels in bestanden. Servercode leest ze uit `process.env`. Bestanden die
  `*.server.ts` heten worden nooit vanuit clientcode geïmporteerd.
- Routes staan in `src/routes` (bestandsgebaseerd). `src/routeTree.gen.ts` wordt gegenereerd door de build;
  bewerk dat bestand niet met de hand.
- Bestaand gedrag blijft werken: cache van 5 minuten, periodes dag/komend/alle, filter op monteur,
  het detailpaneel en de vernieuwknop.
- De logica die Odoo-gegevens omzet naar afspraken staat in `src/lib/appointments.ts` (zonder I/O) met tests in
  `test/appointments.test.ts`. Pas je die logica aan, werk dan de tests bij of voeg tests toe, ook voor
  randgevallen zoals een bezoek dat naar een niet-geladen planning verwijst.
- `scripts/demo-data.mjs` bevat de testgegevens voor de tool `probe_app` (met lastige gevallen zoals meerdere
  bezoeken op één afspraak, een bezoek met een niet-geladen planning en lege velden). Verwerk je een nieuw soort
  record of veld, voeg dan een voorbeeld toe aan dat bestand, zodat je het resultaat met `probe_app` kunt bekijken.
- Je bent pas klaar als alle beschikbare checks slagen (`typecheck`, `lint` en, als ze beschikbaar zijn,
  `build` en `test`). Is een check niet beschikbaar, zeg dat dan in je samenvatting.
