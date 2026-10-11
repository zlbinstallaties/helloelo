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

### Waar de gegevens in Odoo komen: op de klant (gekozen)

Gekozen is **op de klant** (`res.partner`): de gegevens van een schouw komen als velden bij de klant, op het tabblad **Schouwgegevens**.
Zo ziet iedereen ze bij de klant en kan de offerte-assistent ze later overnemen (bijvoorbeeld met een knop die vult wat leeg is).

Zo werkt het:

1. De monteur verstuurt een **schouwdocument**. Het PDF komt bij de klant (de bestaande actie `post_document`).
2. **Daarna**, en alleen voor een schouw, vraagt het dashboard de gateway de schouwgegevens bij de klant in te vullen
   (`set_customer_facts`). Wat er gaat, staat in `src/lib/documents/customer-facts.ts`: de lijst van 19 gegevens (de datum van de schouw
   erbij), hun Odoo-veld (`dig_schouw_...`), type en toegestane waarden. Ja en nee zijn een keuze (*ja* of *nee*), geen vinkje, want een
   vinkje kan *nee* niet van *niet ingevuld* onderscheiden.
3. De gateway leest welke van die velden bij de klant **nog leeg** zijn en vult **alleen die**. Wat iemand zelf invulde, of wat een
   eerdere schouw er al zette, wordt **nooit overschreven**: dat is ook de regel van de offerte-assistent. Het antwoord zegt hoeveel er is
   ingevuld en hoeveel er al stond, en het scherm van de monteur laat dat zien.
4. Mislukt dit, dan blijft het document gewoon bij de klant staan; het scherm zegt dat de gegevens niet zijn gezet, en ze staan ook in het PDF. Het
   wordt niet vanzelf opnieuw geprobeerd. Een oplevering geeft geen gegevens voor de klant (het apparaat hoort later bij een eigen apparaatrecord).

Instellen:

- **Odoo:** installeer de module `odoo_addon/dig_schouw_facts` (zet de map in het addons-pad en installeer *DIG Schouwgegevens op de klant*). Ze
  maakt de velden aan en het tabblad; ze heeft geen eigen tabellen of toegangsregels. De Odoo-gebruiker achter de API-sleutel van de gateway moet
  contacten mogen wijzigen (in Odoo bijvoorbeeld de groep *Contact aanmaken*; niet in Odoo 20 gecontroleerd).
- **Gateway:** in het projectconfig `"actions": { "setCustomerFacts": {} }` (standaard hoogstens 60 schrijfacties per uur); lokaal
  `bun run local:setup ... --customer-facts`. **Zonder deze instelling doet het dashboard niets bij de klant** (de monteur ziet niets). Zonder de module
  in Odoo is het antwoord `fields_not_installed` en staat er niets geschreven.
- Een test (`test/odoo-addon-facts.test.ts`) controleert dat de namen, typen en keuzes van de module hetzelfde zijn als die van de lijst in het
  dashboard. Wijzig je het één, wijzig dan ook het ander.

Wat dit **niet** doet:

- De offerte-assistent leest de velden nog niet; dat is een wijziging in `dig_quote_assistant` (niet in deze repository). Hij kan ze bij een
  nieuwe intake invullen waar die leeg is, op dezelfde manier als zijn andere automatische velden.
- Het is een gegeven **per klant**, niet per project: een tweede schouw bij dezelfde klant overschrijft niets en vult alleen wat nog leeg is. Wil
  een planner ze vervangen, dan doet hij dat in Odoo met de hand.
- Niets is tegen een echte Odoo geprobeerd: de aanroepen (`search_read` en `write` op `res.partner`) en de module zijn opgesteld uit de
  documentatie van Odoo 20 en getest tegen de demo-Odoo en met tests; de module is hier niet in Odoo geladen. Probeer eerst op een lokale of
  weggooi-Odoo.

## Wijzigen

Alleen `forms.ts` (en de tests die de velden noemen). Verander nooit het `id` van een veld dat al gebruikt is; voeg een
nieuw veld toe en verhoog `version` als de vragen op een manier veranderen die voor oude documenten uitmaakt. Het PDF
drukt de versie af.

## Nog niet gedaan

- Vergelijken met de echte DIG-formulieren en de IBS-documentatie, en de technische punten laten nakijken.
- De offerte-assistent de schouwgegevens van de klant laten overnemen (`dig_quote_assistant`).
- De module en de actie op een echte Odoo 20 proberen (eerst lokaal of op een weggooi-database).
- Een eigen veldsoort voor meetwaarden met de uitkomsten *gemeten*, *onbekend* en *niet van toepassing*. Nu is leeg
  "niet ingevuld".
- Per type een eigen vervolg voor airco, thuisbatterij, vloerverwarming en ventilatie (de schouw heeft nu een algemene
  kern).
- Korte stappen in plaats van één lang scherm, een documentnummer in het PDF en een handtekening die de server kan
  controleren (zie de beoordeling van de documentenflow).
