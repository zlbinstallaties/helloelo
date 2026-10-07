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

## Wat dit nog NIET doet: naar Odoo

De keuze is dat de beschikbaarheid **ook in Odoo** komt, zodat Planning er rekening mee houdt. Dat is **nog niet gebouwd**: nu staat
alles alleen in het dashboard, en Odoo Planning weet er niets van. De stap daarna is een smalle gateway-actie (uit tenzij je haar
aanzet) die per periode één niet-beschikbaar-record voor één medewerker in Odoo zet en weer weghaalt, zonder dienst of planning
aan te maken. Welk Odoo 20-model daarvoor het beste is, moet eerst op een echte Odoo worden gecontroleerd (een alleen-lezen
controle, zie hieronder); daarom is die stap nog niet gebouwd.

## Zo probeer je het lokaal

1. Log in als planner, voeg bij Beheer een monteur toe en bewaar zijn wachtwoord.
2. Log (in een ander browservenster of privévenster) in als die monteur en kies **Beschikbaarheid**.
3. Geef een periode door; probeer dezelfde nog eens (melding "overlapt") en verwijder haar weer.
4. Kijk als planner bij **Beschikbaarheid**: je ziet de periode met de naam van de monteur, zonder formulier of knoppen.
