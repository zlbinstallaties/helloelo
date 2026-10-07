# Beschikbaarheid doorgeven

Een monteur geeft zelf door wanneer hij **niet beschikbaar** is (vakantie, ziek, een afspraak). De planner ziet dat van alle
monteurs. Het scherm heet **Beschikbaarheid** (bovenin naast Afspraken).

## Wat de monteur doet

Een periode is een **eerste dag**, een **laatste dag** (die telt mee) en een opmerking die niet verplicht is. Voor één dag vul je
alleen de eerste dag in. Hij ziet en verwijdert alleen zijn eigen periodes die nog niet voorbij zijn. Wijzigen doet hij door
te verwijderen en opnieuw door te geven.

## Wat de planner ziet

Alle periodes die nog niet voorbij zijn, per monteur, op volgorde van datum. De planner kan niets doorgeven of verwijderen: het is
de eigen opgave van de monteur.

## Wat de server afdwingt (bij elk verzoek)

- Van wie een periode is, komt uit de sessie. Een verzoek mag alleen `from`, `to` en `note` bevatten; elk ander veld (een account,
  een medewerker, een id, iets van Odoo) wordt geweigerd (`400`).
- Alleen een monteur geeft door of verwijdert (de planner krijgt `403`); een verzoek dat iets wijzigt heeft het kopje
  `X-Dig-Dashboard: 1` nodig, net als de rest van het dashboard.
- De periode van een ander lijkt niet te bestaan (`404`), ook niet bij raden van een id.
- Echte kalenderdagen (`2026-10-07`), de laatste dag niet voor de eerste, hoogstens 366 dagen, niet helemaal in het verleden,
  hoogstens twee jaar vooruit, opmerking hoogstens 200 tekens op één regel. Vandaag is de dag in Nederland.
- Periodes van één monteur mogen niet overlappen (`409`; een dubbele klik geeft dus geen dubbele periode) en een monteur heeft
  hoogstens 50 periodes die nog niet voorbij zijn.
- Verwijdert de planner het account van een monteur, dan gaan zijn periodes mee.
- Met inloggen uit bestaat dit niet (`404`).

De opmerking wordt altijd als tekst getoond, nooit als HTML.

## Waar het staat

In `availability.json` in de datamap (`DIG_DATA_DIR`, naast `accounts.json`), geschreven als één geheel en atomisch, alleen
leesbaar voor de serverbeheerder. Maak er een back-up van samen met `accounts.json`. Wat meer dan 30 dagen voorbij is, wordt bij
de volgende wijziging vergeten. Een beschadigd bestand wordt als geheel geweigerd met een duidelijke melding; het wordt nooit
"gerepareerd" of overschreven.

## Naar Odoo

Een periode van een monteur die aan een Odoo-medewerker hangt (`employee:<nummer>`) gaat ook naar Odoo, door de gateway, als **één
record** dat zegt dat die medewerker in die dagen niet beschikbaar is (`resource.calendar.leaves` voor zijn resource, in Odoo 20
gezien met de velden `name`, `date_from`, `date_to`, `resource_id`, `calendar_id`). Het is **geen dienst, geen planning en geen
verlofaanvraag**. In Odoo Planning (Inplannen, Per resource) staan alle monteurs als rij en zijn de doorgegeven dagen bij die monteur grijs, net
als het weekend; een beschikbare monteur herken je dus aan een niet-grijze dag in zijn rij, en daar zet de planner een klus neer (zo gezien op een lokale
Odoo 20).

- De dagen worden hele dagen in de tijdzone van de medewerker in Odoo (00:00:00 tot 23:59:59), als UTC aan Odoo gegeven. Heeft de
  medewerker geen bekende tijdzone, dan gaat er niets naar Odoo en zegt het scherm dat.
- De periode is de eigen opgave van de monteur: **ze blijft in het dashboard staan, wat Odoo ook zegt**. Wat bekend is van het record
  staat erbij:

  | Label | Betekenis |
  |---|---|
  | **In Odoo** | Odoo gaf een record terug en terugkijken bevestigde de medewerker en de dagen ("niet gecontroleerd" als het terugkijken mislukte) |
  | **Alleen in dashboard** | de monteur hangt niet aan een Odoo-medewerker, of het doorgeven aan Odoo staat uit op de server |
  | **Niet in Odoo gekomen** | Odoo of de gateway weigerde, of Odoo was niet bereikbaar vóór er iets geschreven werd: er is niets aangemaakt, met de reden erbij. De knop **Naar Odoo sturen** probeert het opnieuw (met hetzelfde nummer, dus nooit twee records) |
  | **Onzeker of in Odoo** | geen bruikbaar antwoord (bijvoorbeeld een time-out): het record kan bestaan. Het wordt **niet** opnieuw gestuurd; de planner kijkt in Odoo (Planning) |

- **Verwijderen** haalt eerst het record in Odoo weg, en pas daarna de periode. Lukt dat niet (Odoo weigert, geen antwoord, of het
  doorgeven staat uit), dan blijft de periode staan met een duidelijke melding, zodat er niets in Odoo achterblijft; opnieuw
  verwijderen is niet erg. Welke medewerker en welk record, komt uit wat bij de periode is bewaard, nooit uit het verzoek van de
  browser, ook niet als het account later aan een andere medewerker is gekoppeld.
- Verwijdert de planner het **account** van een monteur, dan gaan zijn periodes uit het dashboard mee, maar de records in Odoo blijven
  staan (ze beginnen met `[Dashboard] Niet beschikbaar`; verwijder ze zo nodig in Odoo).
- De gateway-actie is een aparte instelling `employeeUnavailability` die **uit staat** tenzij je haar aanzet; `bun run local:setup
  --responsible-id ...` zet haar aan. Zie `docs/odoo-gateway.md`.

Nog niet tegen een echte Odoo 20 gezien: wat Odoo doet als de planner toch een dienst op een grijze dag zet, het verwijderen van het
record vanuit het dashboard, en of een Odoo-gebruiker die geen `admin` is (de gebruiker achter de gateway) dit mag (rechten op
`resource.calendar.leaves`).

## Zo probeer je het lokaal

1. Log in als planner, voeg bij Beheer een monteur toe en bewaar zijn wachtwoord.
2. Log (in een ander browservenster of privévenster) in als die monteur en kies **Beschikbaarheid**.
3. Geef een periode door; probeer dezelfde nog eens (melding "overlapt") en verwijder haar weer.
4. Kijk als planner bij **Beschikbaarheid**: je ziet de periode met de naam van de monteur, zonder formulier of knoppen.
5. Met de lokale Odoo erachter: kijk of het label **In Odoo** verschijnt en zoek het record in Odoo (zie `docs/lokaal-testen.md`).
