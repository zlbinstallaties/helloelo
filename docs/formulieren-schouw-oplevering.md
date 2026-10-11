# De formulieren: schouw en oplevering met inbedrijfstelling

De twee formulieren staan als gegevens in `src/lib/documents/forms.ts`. Scherm, controle op de server en PDF werken
vanuit die ene lijst. Dit bestand beschrijft wat erin staat en wat nog moet.

> **Status: voorlopig.** De velden zijn opgesteld uit sectie 6 van de DIG-masterprompt en uit wat gebruikelijk is bij een
> schouw en bij het in bedrijf stellen van een warmtepomp. Ze zijn **nog niet vergeleken** met het papieren of Word-schouw-
> en opleverdocument en de IBS-documentatie van De Installatiegroep. Laat een monteur of technisch verantwoordelijke de
> technische punten nakijken voordat het formulier wordt gebruikt.

## Schouwdocument (versie 2)

Secties: Locatie · Installatie en plaatsing · Bestaande situatie · Leidingtracé of kabeltracé · Elektrische voorziening ·
Hydraulische aspecten · Werkzaamheden voor de opdrachtgever · Foto's · Afronding · Handtekening van de klant.

- Installatietype: hybride of all-electric warmtepomp, airco, thuisbatterij, vloerverwarming, ventilatie, sanitair, anders.
- Verplicht: parkeren, huisdieren, installatietype, plaatsing, asbest, meterkast, drie vragen over werk voor de
  opdrachtgever (graafwerk, stroom, werkruimte) en "compleet voor de werkvoorbereiding" (bij Nee: wat ontbreekt).
- Meetwaarden en lengtes zijn optioneel; leeg betekent "Niet ingevuld" in het PDF. Er wordt nooit een waarde ingevuld.
- De veldnamen uit versie 1 zijn gebleven; er zijn alleen velden bijgekomen en de keuzes van het installatietype zijn
  gewijzigd.

## Opleverdocument en inbedrijfstelling (versie 2)

Het opleverdocument is ook het inbedrijfstellingsdocument (IBS), voor **monoblock-warmtepompen** en **split-systemen**.
Eerst kiest de monteur *Soort installatie*: Monoblock warmtepomp, Split-systeem of Overig (alleen oplevering).

| Onderdeel | Monoblock | Split | Overig |
|---|---|---|---|
| Uitgevoerde werkzaamheden, oplevering aan de klant, foto's, handtekening | ja | ja | ja |
| Apparatuur (merk, type, serienummers van de typeplaatjes, foto's) | ja | ja | nee |
| Inbedrijfstelling (datum, protocol van de fabrikant, elektra, opstelling, storingen) | ja | ja | nee |
| Meetwaarden (buiten-, aanvoer- en retourtemperatuur, debiet, instellingen) | ja | ja | nee |
| Waterzijdig (spoelen en ontluchten, vorstbescherming, isolatie, waterdruk) | ja | nee | nee |
| Koudemiddelcircuit (dichtheid, vacuüm, gecertificeerde monteur, type en hoeveelheid koudemiddel, leidinglengte) | nee | ja | nee |

Het formulier zegt zelf dat het het inbedrijfstellingsprotocol van de fabrikant **niet vervangt**; er is een verplichte
vraag of dat protocol is doorlopen.

## Voorwaardelijke onderdelen (`showWhen`)

Een sectie of veld kan `showWhen: { field, in: [...] }` hebben: het is er alleen als een eerder gekozen antwoord (een
keuzeveld) een van die waarden heeft. Dat geldt overal:

- op de telefoon verschijnt of verdwijnt het onderdeel meteen; wat al was ingevuld blijft bewaard als je terugschakelt;
- de telefoon stuurt alleen antwoorden mee die bij de keuzes passen;
- de server controleert alleen wat van toepassing is en **laat andere antwoorden vallen**, ook als iemand ze toch stuurt;
- het PDF drukt alleen af wat van toepassing is.

Een test (`test/documents-submission.test.ts`) controleert dat elke regel naar een eerder keuzeveld wijst, met bestaande
waarden.

## Gegevens voor de klant en de offerte-engine

Wat een monteur invult is niet alleen een PDF. Een aantal antwoorden is **een gegeven dat later bij de klant bruikbaar is**,
in het bijzonder voor de offerte-assistent (`dig_quote_assistant`). Daarom heeft zo'n veld in `forms.ts` een `fact`: een vaste
naam. `src/lib/documents/facts.ts` (`extractFacts`) zet de antwoorden van een document om in zulke gegevens
(`{ schema: 'dig.facts/1', form, formVersion, facts: { ... } }`).

Regels, zodat een gegeven te vertrouwen is:

- Alleen wat is ingevuld is een gegeven. *Onbekend* en *niet van toepassing* zijn **nooit** een gegeven: een gegeven is geen
  gok. De offerte-assistent vult alleen lege velden, en leeg is dan wat waar is.
- Getallen zijn getallen (komma wordt punt), de eenheid zit in de naam (`leidinglengte_m`). Ja en nee zijn waar en onwaar.
- Wat niet bij de gemaakte keuzes hoort (`showWhen`) is geen antwoord en dus geen gegeven.

### Wat de offerte-engine vraagt en waar het in het formulier staat

Bron: de invoer van de offerte-assistent zoals beschreven in de artifacts "Rekenlogica offerte-assistent" en "Oplevering
architectuur rekenmotor" (versies lopen daar uiteen; niet gecontroleerd tegen de code van de module).

| Invoer van de engine | Veld in het schouwformulier | Gegeven |
|---|---|---|
| Gewenst systeem (hybride of all-electric) | Installatietype | `gewenst_systeem` |
| Afgiftesysteem (vloer, radiatoren, lage-temperatuurradiatoren, mix) | Warmteafgifte | `afgiftesysteem` |
| Isolatie (goed, matig, slecht) | Isolatie van de woning | `isolatie` |
| Aantal personen | Aantal personen in de woning | `aantal_personen` |
| Ruimte voor installatie (weinig, voldoende) | Ruimte voor de installatie | `ruimte_installatie` |
| Boileropstelling (horizontaal, staand) | Opstelling van de boiler of buffer | `boiler_opstelling` |
| Leidingroute (vrije tekst) | Tracé, doorvoeren en obstakels | `leidingroute` |
| Bouwjaar | Bouwjaar woning | `bouwjaar` |
| Jaarverbruik gas | Jaarverbruik gas | `gasverbruik_m3_per_jaar` |

Ook vastgelegd, ook al heeft de engine er nu geen invoer voor: geschatte lengte van het tracé (`leidinglengte_m`; bij een split
rekent de engine "per meter extra", maar hoe die lengte binnenkomt staat nergens), aansluiting 1-fase of 3-fase (`aansluiting`;
het product heeft dit label, de woning nog niet), ruimte in de meterkast, vrije groep, vermoeden van asbest, werk dat de klant zelf
doet (graafwerk, stroom, werkruimte) en *schouw compleet* (`schouw_compleet`; dat is ook de vrijgave "schouw compleet" van het
installatiedossier). Uit het opleverdocument: soort installatie, merk, type, serienummers, datum inbedrijfstelling en
koudemiddel, voor het apparaat bij de klant.

Bewust **niet** gevraagd, omdat het uit een andere bron komt: het benodigde vermogen (kW, uit de EP-berekening), het
energielabel, BAG-gegevens en de contactgegevens van de klant.

### Waar de gegevens in Odoo komen: nog te beslissen

Dit repository kent de gegevens nu alleen als `dig.facts/1`. Er gaat nog **niets** naar Odoo, want dat vraagt een keuze en
velden aan de Odoo-kant (de module staat niet in deze repository). De opties:

| Optie | Voor | Tegen |
|---|---|---|
| A. Op de intake van de offerte-assistent (`dig.quote.intake`) | de engine leest het direct en vult alleen lege velden | nieuwe velden in `dig_quote_assistant`, dat volgens de bron nog niet is gecommit |
| B. Op de klant (`res.partner`), als velden of een tabblad "Schouwgegevens" | zichtbaar bij de klant en bruikbaar voor elke module | eigen velden in Odoo, en een nieuwe smalle schrijfactie in de gateway |
| C. Als bestand bij het PDF (`schouw-gegevens-<datum>.json`) | kleinste wijziging, leesbaar en later te verwerken | geen veld om op te zoeken of te filteren |

De regels van de engine zelf gelden voor elke keuze: nooit een door een medewerker ingevuld veld overschrijven, de klant alleen
koppelen als dat zeker is (hier komt die uit de afspraak), en nooit iets verzenden of bevestigen. Elke nieuwe schrijfactie naar
Odoo is een opdracht die een mens beoordeelt (`RULES.md`).

## Wijzigen

Alleen `forms.ts` (en de tests die de velden noemen). Verander nooit het `id` van een veld dat al gebruikt is; voeg een
nieuw veld toe en verhoog `version` als de vragen op een manier veranderen die voor oude documenten uitmaakt. Het PDF
drukt de versie af.

## Nog niet gedaan

- Vergelijken met de echte DIG-formulieren en de IBS-documentatie, en de technische punten laten nakijken.
- De gegevens bij de klant opslaan (zie hierboven; eerst kiezen waar).
- Een eigen veldsoort voor meetwaarden met de uitkomsten *gemeten*, *onbekend* en *niet van toepassing*. Nu is leeg
  "niet ingevuld".
- Per type een eigen vervolg voor airco, thuisbatterij, vloerverwarming en ventilatie (de schouw heeft nu een algemene
  kern).
- Korte stappen in plaats van één lang scherm, een documentnummer in het PDF en een handtekening die de server kan
  controleren (zie de beoordeling van de documentenflow).
