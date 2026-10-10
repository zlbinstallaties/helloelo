# Schouw- en opleverdocumenten

Een monteur (of de planner) vult een schouw- of opleverdocument in op zijn telefoon, de klant tekent op het scherm, en
het ondertekende PDF komt als bijlage met een interne notitie bij die klant in Odoo te staan. Er gaat **geen mail** uit.

## Zo werkt het

1. In het detailpaneel van een afspraak staan de knoppen **Schouw invullen** en **Oplevering invullen** (alleen voor wie
   is ingelogd). Ze openen `/document/schouw/<afspraak>` of `/document/oplevering/<afspraak>`.
2. Het formulier (grote knoppen, camera, handtekening) bewaart een **concept op de telefoon** (IndexedDB, met foto's en
   handtekening), keert terug na herladen of als de browser de tab uit het geheugen haalde, en wordt gewist na het
   versturen of na een week. Het concept hoort bij één persoon, één soort document en één afspraak.
3. **Versturen** doet `POST /api/documents` met alleen `type`, `appointmentId`, `submissionId`, `answers` en `signature`.
   De server (`src/lib/document-handlers.ts`, via `handlers.ts`, dus met inloggen en rechten):
   - een monteur kan alleen voor **zijn eigen afspraken** versturen, de planner voor elke afspraak; een afspraak van een
     ander is `404`;
   - de ingelogde gebruiker is de **auteur** in het PDF; een `author` in het verzoek is `400`, evenals elk ander onbekend veld;
   - de klant komt **nooit** van de telefoon: de afspraak bepaalt het record (`planning.slot`, anders `svs.tech.visit`) en de
     gateway leest daar de klant van;
   - het formulier wordt opnieuw gecontroleerd met dezelfde regels als op de telefoon (`validateSubmission`, `422` met de
     fouten per veld) en het PDF wordt op de server gemaakt (`renderDocumentPdf`);
   - het **journaal** (`document-requests.json` in `DIG_DATA_DIR`) wordt geschreven *voordat* de gateway wordt gevraagd. Het
     bewaart alleen welke afspraak, welk soort, wie, wanneer en het resultaat; nooit antwoorden, foto's, handtekening, klant of
     bestand.
4. De gateway (`post_document`, zie `docs/odoo-gateway.md`) leest de klant, maakt de bijlage en de interne notitie.

### Wat er bij een mislukking gebeurt

| Uitkomst | Betekent | Wat de monteur ziet |
|---|---|---|
| verstuurd | het bestand staat bij de klant (`noted: false`: de notitie ontbreekt, het bestand staat er wel) | "Verstuurd", met de klant uit Odoo |
| geweigerd door Odoo of de gateway | er is **niets** geplaatst; opnieuw proberen mag, met hetzelfde nummer | melding en "Opnieuw proberen" |
| geen verbinding | de telefoon kreeg geen antwoord; het nummer van het concept maakt opnieuw proberen veilig | "Geen verbinding", concept blijft |
| **uitkomst onbekend** (time-out, onbruikbaar antwoord, server stopte) | het bestand **kan** er staan | "Niet zeker of het is aangekomen": **niet** opnieuw versturen; de planner kijkt bij de klant in Odoo. Pas als het er niet staat kan de monteur bewust opnieuw versturen, wat een nieuw nummer (en dus een nieuw document) maakt |

Hetzelfde `submissionId` nog eens sturen (dubbel tikken, verloren antwoord) geeft hetzelfde antwoord zonder tweede bijlage. Een
`submissionId` van iemand anders of voor een andere afspraak is `409`.

### Aanzetten

Uit tenzij het gateway-project het vraagt: `"actions": { "postDocument": {} }` (standaard hoogstens 60 per uur voor het hele
project, `maxPerHour` past dat aan). In de lokale proef: `bun run local:setup --force ... --documents`
(`bun run local:rehearsal` zet het voor de demo-Odoo vanzelf aan). De Odoo-gebruiker achter de API-sleutel moet bijlagen mogen
aanmaken en notities op klanten mogen plaatsen. Staat het uit, dan krijgt de monteur pas bij het versturen een melding; het concept blijft dan bewaard.

### Bestanden

| Bestand | Doel |
|---|---|
| `src/lib/documents/forms.ts` | De twee formulieren als gegevens (`FORMS.schouw`, `FORMS.oplevering`): secties, velden, ja/nee met toelichting, foto's |
| `src/lib/documents/submission.ts` | `validateSubmission(form, input)`: controleert wat een telefoon stuurt; in de browser én op de server |
| `src/lib/documents/form-state.ts` | Het concept op de telefoon (wijzigingen, foto's, handtekening), `toPayload`, `validateDraft`, `parseDraft`; zonder React |
| `src/lib/documents/draft-store.ts` | Het concept bewaren (IndexedDB, met een geheugenversie voor tests); fouten van de opslag breken het formulier nooit |
| `src/lib/documents/photo.ts`, `photo-browser.ts` | Foto's verkleinen naar 1600 px, JPEG 0,8, en zo nodig kleiner tot ze onder de grens van de server zitten |
| `src/lib/documents/jpeg.ts`, `pdf.ts`, `render.ts` | JPEG lezen, kleine PDF-schrijver, `renderDocumentPdf`, `documentFilename`, `documentSummary` |
| `src/lib/document-handlers.ts`, `document-journal.ts` | De serverroute met rechten, en het journaal |
| `src/lib/gateway-document.ts`, `gateway.server.ts` | De aanroep van de gateway en de uitleg van het antwoord |
| `src/components/documents/*`, `src/routes/document.$type.$appointmentId.tsx` | Het scherm: formulier, handtekening, foto's |

De velden in `forms.ts` zijn **voorbeeldvelden** tot de echte papieren of Word-formulieren er zijn. Vervangen is een
wijziging in dat ene bestand; controle, scherm en PDF volgen vanzelf. Verander nooit het `id` van een veld dat al gebruikt is.

### Privacy van het concept

Het concept (met foto's van de woning van de klant en een handtekening) staat op de telefoon van de monteur, onder zijn
account, en blijft staan als hij uitlogt of zijn sessie verloopt, zodat hij verder kan na opnieuw inloggen. Concepten die een
week niet zijn aangeraakt worden bij het volgende gebruik van het formulier gewist. Op een gedeelde telefoon: verstuur het
document of kies "Opnieuw beginnen".

## Het formulier op een telefoon (zo is het gebouwd)

- Invoervelden minimaal 16 px (iOS zoomt anders in), knoppen en keuzes minimaal 44 px hoog.
- Ja / Nee / n.v.t. als grote knoppen naast elkaar, geen keuzelijst.
- Foto's via `<input type="file" accept="image/*" capture="environment">`; verklein ze in de browser naar maximaal
  1600 px, JPEG kwaliteit 0,8 (ongeveer 250 KB). De controle accepteert maximaal 700.000 tekens per foto en 12 foto's.
- De handtekening is een `<canvas>` met `touch-action: none`, een witte achtergrond en export als JPEG
  (`canvas.toDataURL('image/jpeg', 0.92)`). De server controleert niet of er echt getekend is: laat de knop
  "Afronden" pas werken na minstens één streek.
- Bewaar een concept in IndexedDB, **inclusief foto's**. Een telefoon haalt de browsertab vaak uit het geheugen
  terwijl de camera-app open is, en dan is anders alles weg.
- Toon de fouten per veld uit `validateSubmission` en spring naar het eerste foute veld.

## Huisstijl uit Claude Design

Bronnen: "Logo De Installatiegroep" en "Audit — De Installatiegroep Design System" (Claude Design).

| Token | Waarde | Gebruik |
|---|---|---|
| Navy (ink) | `#16283C` | tekst, titels, het merkteken |
| Papier | `#F7F5F1` | achtergrond van panelen |
| Koper (naad) | `#B87333` | alleen decoratie: de naad in het merkteken, de punt in het woordmerk, streepjes |
| Koper voor tekst | `#9F6229` | kleine tekst in koper |
| Secundaire tekst | `#4E6B87` | labels, voettekst (ongeveer 5:1 op wit) |
| Haarlijn | `#DCDCDB` | randen en scheidingslijnen |

- Lettertypen: Fraunces (serif) voor titels, Inter voor lopende tekst.
- Woordmerk: "De Installatiegroep" in Fraunces 600 met een koperen punt; merkteken is een navy vierkant met een
  koperen streep op 40/64 van de breedte.
- **PDF**: gebruikt deze kleuren. Het gebruikt Times-Bold en Helvetica als vervanging voor Fraunces en Inter (dat zijn
  de reservelettertypen uit de huisstijl zelf). De echte lettertypen insluiten vraagt de fontbestanden en een
  subset-stap; dat is niet gedaan.
- **Dashboard**: `src/styles.css` heeft dezelfde waarden als tokens (zie `docs/huisstijl.md`), dus scherm en PDF passen bij
  elkaar. Het formulier gebruikt de shadcn-componenten met die kleuren, niet de eigen formuliercomponenten van het
  designsysteem.
- De audit van het designsysteem waarschuwt voor die eigen formuliercomponenten: geen zichtbare toetsenbordfocus, een Radio die
  niet kan wisselen, een Tag die een `span` is, foutmeldingen zonder `aria-invalid` en `aria-describedby`. Het formulier doet
  het zo: elk besturingselement heeft een zichtbare focusring van 3 px in koper, ja/nee zijn echte radioknoppen (pijltjes en
  spatie werken), een fout staat onder het veld, hangt eraan met `aria-describedby`, en het veld krijgt `aria-invalid`; na een
  mislukte poging springt de focus naar het eerste foute veld. De handtekening zelf is alleen met een vinger, pen of muis te
  zetten; het veld is wel te focussen en te wissen.
- Kleine tekst in koper alleen met `#9F6229`; `#B87333` haalt op wit te weinig contrast.

## Controleren

```bash
bun run test:app          # bevat de documenttests, de serverroute en het concept
bun run test:gateway      # de gateway-actie (documents.test.ts)
bun run test:odoo         # de Odoo-client en de demo-Odoo (bijlage en notitie)
bun run typecheck && bun run typecheck:gateway && bun run lint
```

Zelf proberen met de demo-Odoo (geen echte Odoo): `bun run local:rehearsal start`, inloggen, bij een afspraak *Details*, dan
*Schouw invullen*; na het versturen staan in `bun run local:rehearsal logs` de regels `ATTACH ...` en `NOTE ...` ("no mail, no
recipients"). Een account moet aan een medewerker uit de planning hangen om afspraken te zien (Beheer, Accounts).

Een voorbeeld-PDF maken en bekijken: render met `renderDocumentPdf` (zie `test/documents-pdf.test.ts` voor de invoer)
en zet het om met `pdftoppm -r 80 -png bestand.pdf pagina`.

## Open punten

- Echte formulieren in plaats van de voorbeeldvelden.
- De PDF-lettertypen zijn standaardlettertypen (zie hierboven).
- **Niet getest tegen een echte Odoo 20**: `ir.attachment/create` (met `vals_list`) en `res.partner/message_post` (met `ids`,
  `subtype_xmlid`) zijn uit de documentatie opgesteld en alleen tegen de demo-Odoo geprobeerd, net als het lezen van
  `partner_id` op `planning.slot` en `svs.tech.visit` (die velden bestaan op de lokale Odoo niet; de DIG-modules zijn nodig).
- **Mail naar de klant** is niet gebouwd: pas in productie, en in de testfase alleen naar een testadres. De gateway werkt nu
  alleen tegen de Odoo-testserver.
- Geen eigen PDF-bibliotheek gebruikt, om geen afhankelijkheid toe te voegen. Het is bewust klein: tekst, lijnen,
  vlakken en JPEG's. Voor meer (tabellen, eigen lettertypen) is een bibliotheek als `pdf-lib` de betere keuze.
