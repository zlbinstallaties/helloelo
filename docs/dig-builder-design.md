# Ontwerp toekomstige DIG Builder

## Doel en grens

De toekomstige DIG Builder is een aparte Odoo 20-module voor beheerders. Hij maakt gecontroleerde voorstellen voor dashboards of andere DIG-apps; hij is niet hetzelfde product als het huidige monteursdashboard.

- **Monteursdashboard**: bestaande leesapp voor operationele `planning.slot`-afspraken en `svs.tech.visit`-formulieren.
- **DIG Builder**: beheerdersapp die modelonderzoek, ontwerp, codevoorstellen, tests en goedkeuring orkestreert.

De builder mag nooit automatisch willekeurige Odoo-modellen wijzigen of een parallelle planning creëren. Standaard Odoo Planning en standaard Odoo-commissies blijven de bron voor die domeinen.

## Toegang en serverrechten

Maak een expliciete beheerdersgroep, bijvoorbeeld `group_dig_builder_admin`, met minimale modelrechten. Controleer de groep:

- in elke Odoo-controller of server action vóór modelonderzoek;
- opnieuw vóór het opslaan van een voorstel;
- opnieuw vóór installatie of migratie;
- nooit uitsluitend met een verborgen knop of browserfilter.

Gebruik Odoo ACL’s en record rules voor Odoo-data. Gebruik daarnaast server-side app-authenticatie met audit logging. Een chatprompt is geen autorisatie.

## Modelonderzoek

1. Lees `ir.model` en `ir.model.fields` voor toegestane modellen.
2. Toon relaties en veldtypen, maar minimaliseer recorddata.
3. Markeer standaard versus custom modellen, bijvoorbeeld DIG/SVS-modellen.
4. Gebruik `planning.slot` als operationele afsprakenbron.
5. Gebruik `svs.tech.visit` voor bezoekformulieren.
6. Gebruik `project.task` alleen als historische of uitvoeringsreferentie.
7. Gebruik standaard commissieplannen, targets en achievements als ze zijn geconfigureerd; bereken geen parallelle commissieadministratie.

## Chat en voorstellen

De chat mag een beheerder helpen een voorstel te formuleren, maar het antwoord moet een expliciet voorstelobject opleveren:

- doel en gebruikersgroep;
- geraadpleegde modellen/velden;
- filters en bedrijfscontext;
- voorgestelde routes en UI-schermen;
- Odoo-schrijfacties, als die überhaupt nodig zijn;
- risico’s, tests en rollbackplan.

De builder schrijft eerst naar een geïsoleerde werkruimte of branch, nooit direct naar productie-Odoo of de hoofdbranch.

## Codegeneratie en testen

- Genereer alleen applicatiecode en tests in een geïsoleerde omgeving.
- Neem geen Odoo Enterprise-broncode over.
- Valideer imports, modelnamen en veldnamen tegen de doelversie Odoo 20.
- Test server-side rechten met toegestane en geweigerde gebruikers.
- Test multi-company-afscherming, record rules, foutafhandeling, tijdzones en grote datasets.
- Run lint, typecheck, unit tests en een preview smoke test.
- Gebruik representatieve testrecords zonder klantdata in de repository.

## Goedkeuring, installatie en herstel

1. Beheerder beoordeelt model- en rechtenvoorstel.
2. Reviewer beoordeelt diff, tests en datamigratie.
3. Builder maakt een installatiepakket of module-release.
4. Installatie gebeurt eerst in een geïsoleerde Odoo-testdatabase.
5. Na expliciete goedkeuring kan installatie op een beheerde omgeving plaatsvinden.
6. Voor elke wijziging bestaat een backup-, uninstall- of forward-fixplan.
7. Falen stopt de installatie; er wordt niet stilzwijgend doorgegaan.

## Beoogde Odoo-modulegrenzen

Een toekomstige module kan eigen proposal-, run- en approval-modellen bevatten, maar moet Planning, Verkoop, CRM, Buitendienst en Commissies via standaard Odoo-interfaces gebruiken. De builder mag geen eigen kopieën van `planning.slot` of commissieprestaties introduceren.

Dit is een ontwerpvoorstel. Er is in dit project geen Odoo-module, chat-agent, admin group of installatiepipeline gebouwd.
