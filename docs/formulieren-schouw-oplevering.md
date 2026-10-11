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

## Wijzigen

Alleen `forms.ts` (en de tests die de velden noemen). Verander nooit het `id` van een veld dat al gebruikt is; voeg een
nieuw veld toe en verhoog `version` als de vragen op een manier veranderen die voor oude documenten uitmaakt. Het PDF
drukt de versie af.

## Nog niet gedaan

- Vergelijken met de echte DIG-formulieren en de IBS-documentatie, en de technische punten laten nakijken.
- Een eigen veldsoort voor meetwaarden met de uitkomsten *gemeten*, *onbekend* en *niet van toepassing*. Nu is leeg
  "niet ingevuld".
- Per type een eigen vervolg voor airco, thuisbatterij, vloerverwarming en ventilatie (de schouw heeft nu een algemene
  kern).
- Korte stappen in plaats van één lang scherm, een documentnummer in het PDF en een handtekening die de server kan
  controleren (zie de beoordeling van de documentenflow).
