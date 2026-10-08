# Schouw- en opleverdocumenten

Een monteur vult een schouw- of opleverdocument in op zijn telefoon, de klant tekent op het scherm, en het
ondertekende PDF komt bij de klant in Odoo te staan. Dit document beschrijft wat er klaar is, wat een andere
sessie of opdracht nog moet aansluiten, en welke huisstijl erbij hoort.

## Wat er klaar is

Alleen losse onderdelen, zonder gateway, route of scherm. Ze raken geen bestaand bestand aan.

| Bestand | Doel |
|---|---|
| `src/lib/documents/forms.ts` | De twee formulieren als gegevens (`FORMS.schouw`, `FORMS.oplevering`): secties, velden, ja/nee met toelichting, foto's |
| `src/lib/documents/submission.ts` | `validateSubmission(form, input)`: controleert wat een telefoon stuurt en geeft het schone resultaat of foutmeldingen per veld. Bedoeld voor browser én server |
| `src/lib/documents/jpeg.ts` | Leest afmetingen en kleurkanalen uit een JPEG, zodat foto's ongewijzigd in het PDF kunnen |
| `src/lib/documents/pdf.ts` | Kleine PDF-schrijver zonder dependency: tekst (Helvetica, Times-Bold), lijnen, vlakken, JPEG's, A4 |
| `src/lib/documents/render.ts` | `renderDocumentPdf(form, context, submission)`, `documentFilename`, `documentSummary` |
| `test/documents-*.test.ts` | 17 tests, ook van de PDF-structuur (xref-offsets, pagina's) en, als `pdftotext` bestaat, van de tekst |

De velden in `forms.ts` zijn **voorbeeldvelden** tot de echte papieren of Word-formulieren er zijn. Vervangen is een
wijziging in dat ene bestand; controle en PDF volgen vanzelf. Verander nooit het `id` van een veld dat al gebruikt is.

## Wat nog moet (hoort bij de dashboard-sessie)

Het dashboard wordt gebouwd in de sessie "Dashboard en documentatie" (branch `claude/loving-lovelace-wzm9hp`). Daar
bestaan al inloggen, rechten en een gateway met benoemde acties. De volgende stappen moeten daar bovenop, dus niet
hier:

1. **Gateway-actie `post_document`** in het patroon van `gateway/src/actions.ts` (aan staat alleen als het projectconfig
   het vraagt, `maxPerHour`, `requestId` met journaal, en de regel "uitkomst onbekend → niet opnieuw proberen").
   - De klant komt **nooit** van de app. De gateway leest `partner_id` van het referentierecord (`planning.slot` of
     `svs.tech.visit`, al gefilterd op het bedrijf) en zet het PDF daar op.
   - In Odoo: `ir.attachment.create` met `res_model = res.partner`, `res_id = <klant>`, daarna
     `res.partner.message_post` met `subtype_xmlid = mail.mt_note` en zonder ontvangers. Dat is een interne notitie
     met bijlage en **stuurt geen mail**.
   - De huidige JSON-limiet van de gateway is 64 KB; deze actie heeft een eigen, hogere limiet nodig (PDF maximaal
     8 MB, als base64 ongeveer 11 MB).
   - Niet getest tegen een echte Odoo 20: de JSON-2-aanroepen (`create` met `vals_list`, `message_post` met `ids`) zijn
     uit de documentatie opgesteld.
2. **Serverroute** via `src/lib/handlers.ts` (zodat inloggen en rechten gelden): afspraak opzoeken (`slot-12` of
   `visit-5`), `validateSubmission`, `renderDocumentPdf`, gateway-actie. Gebruik de ingelogde gebruiker als
   `author` in plaats van een ingetypte naam, en een `submissionId` om dubbel versturen op een slechte verbinding
   te herkennen.
3. **Scherm**: knoppen "Schouw invullen" en "Oplevering invullen" in het detailpaneel, en het formulier zelf.
4. **Mail naar de klant**: pas in productie. In de testfase alleen naar een testadres; de gateway werkt nu alleen
   tegen de Odoo-testserver.

`RULES.md` op die branch zegt dat er maar één schrijfactie is en dat een tweede alleen via een opdracht komt die daar
expliciet over gaat en door een mens wordt beoordeeld. Die opdracht is gegeven in de sessie "Schouw- en
opleverdocumenten koppelen", maar de regel moet daar worden aangepast, door iemand die die branch beheert.

## Het formulier op een telefoon

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
- **Dashboard**: bij het schrijven van dit document gebruikte `src/styles.css` nog het standaard grijze thema van de
  componentenbibliotheek. De sessie die het dashboard bouwt past de kleuren nu aan; gebruik daar dezelfde waarden
  uit de tabel (tokens in `:root`, niet in componenten), zodat scherm en PDF bij elkaar passen.
- De audit van het designsysteem waarschuwt voor de eigen formuliercomponenten: geen zichtbare toetsenbordfocus
  (`--focus-ring` wordt nergens gebruikt), een Radio die niet kan wisselen, een Tag die een `span` is, foutmeldingen
  zonder `aria-invalid` en `aria-describedby`. Neem die componenten dus niet blind over. Gebruik de
  shadcn-componenten van het dashboard, geef ze de huisstijlkleuren en een zichtbare focusring, en koppel foutmeldingen
  aan het veld.
- Kleine tekst in koper alleen met `#9F6229`; `#B87333` haalt op wit te weinig contrast.

## Controleren

```bash
bun run test:app          # bevat de documenttests
bun run typecheck && bun run lint
```

Een voorbeeld-PDF maken en bekijken: render met `renderDocumentPdf` (zie `test/documents-pdf.test.ts` voor de invoer)
en zet het om met `pdftoppm -r 80 -png bestand.pdf pagina`.

## Open punten

- Echte formulieren in plaats van de voorbeeldvelden.
- De PDF-lettertypen zijn standaardlettertypen (zie hierboven).
- Gateway-actie, route, scherm, login-koppeling en mail: zie "Wat nog moet".
- Geen eigen PDF-bibliotheek gebruikt, om geen afhankelijkheid toe te voegen. Het is bewust klein: tekst, lijnen,
  vlakken en JPEG's. Voor meer (tabellen, eigen lettertypen) is een bibliotheek als `pdf-lib` de betere keuze.
