# Planning vraagt bevestiging bij een monteur die niet beschikbaar is

Een monteur geeft in het dashboard door wanneer hij niet beschikbaar is; het dashboard zet daar een record voor in Odoo
(`docs/beschikbaarheid.md`), en Planning toont die dagen grijs. Odoo laat je een dienst op zo'n dag toch gewoon zetten. Deze kleine
Odoo-module (`odoo_addon/dig_planning_unavailability`) zorgt dat Planning dan eerst vraagt:

> **Monteur is niet beschikbaar**
> jan hans is niet beschikbaar van 26-10-2026 00:00 tot 26-10-2026 23:59.
> De monteur heeft dit zelf doorgegeven in het monteursdashboard. Wil je hem toch inplannen?
> [Annuleren] [Toch inplannen]

**Annuleren** laat alles zoals het was (de dienst wordt niet gemaakt of niet verplaatst). **Toch inplannen** doet precies dezelfde actie
alsnog. Het is een gewone Odoo-waarschuwing (`RedirectWarning`): ze verschijnt ook bij het slepen van een dienst in het Gantt-overzicht,
bij een nieuwe dienst en bij het toewijzen van een monteur in het formulier.

## Waar de vraag wel en niet komt

- **Wel:** een dienst die je aanmaakt of wijzigt (begin, einde of toegewezen monteurs) waarbij een toegewezen monteur een **record van het
  dashboard** heeft dat overlapt. Dat is een niet-beschikbaar-record in Planning, Onbeschikbaarheid van resource, waarvan de naam begint
  met `[Dashboard] Niet beschikbaar`. Heeft een dienst meer monteurs, dan staat alleen de niet-beschikbare in de vraag.
- **Niet:** weekenden, feestdagen, een vakantie die iemand met de hand in Odoo zette (die naam begint anders), andere wijzigingen aan
  een dienst (naam, uren, status), en alles wat Odoo zelf doet als systeem (zoals terugkerende diensten die een geplande actie aanmaakt).
- Een dienst die al bestond en nu pas overlapt omdat de monteur later een periode doorgeeft, krijgt geen vraag zolang je haar niet wijzigt.
- De naam `[Dashboard] Niet beschikbaar` staat in twee plekken en moet gelijk blijven: `gateway/src/actions.ts` en
  `odoo_addon/dig_planning_unavailability/models/planning_slot.py`. Een test (`test/odoo-addon-marker.test.ts`) bewaakt dat.

## Alleen lokaal, op jouw Odoo

Dit is een **aparte module in Odoo zelf**; het dashboard en de gateway veranderen er niet door. Installeer haar nu alleen op je lokale
Odoo. Niet op de VPS en niet op een live Odoo of Odoo.sh zonder jouw uitdrukkelijke goedkeuring.

### Installeren (op je Mac)

Stop Odoo, kopieer de module naast Planning, installeer haar en start Odoo weer. Pas het pad aan als je Odoo ergens anders staat:

```bash
~/Developer/odoo20-ee/odoo20.sh stop
cp -R odoo_addon/dig_planning_unavailability ~/Developer/odoo20-ee/odoo-20.0+e.20261004/odoo/addons/
cd ~/Developer/odoo20-ee/odoo-20.0+e.20261004
python -m odoo -c ~/Developer/odoo20-ee/odoo.conf -d dig20-test -i dig_planning_unavailability --stop-after-init
~/Developer/odoo20-ee/odoo20.sh start
```

Je moet `python` in je virtuele omgeving (`venv`) gebruiken; die staat aan als je `(venv)` voor je prompt ziet. Het installeren hoort zonder
foutmelding af te sluiten. Zie je een fout, stuur me die dan.

### Proberen

1. Zorg dat een monteur (bijvoorbeeld jan hans) een periode doorgaf, zoals maandag 26 oktober (het label in het dashboard is **In Odoo**).
2. Ga in Odoo naar **Planning → Inplannen → Per resource** en maak een dienst op die maandag en wijs jan hans toe, of sleep een bestaande
   dienst naar zijn rij op die dag.
3. Je krijgt de vraag **Monteur is niet beschikbaar**. Kies eerst **Annuleren**: er is niets veranderd. Doe het nog eens en kies
   **Toch inplannen**: de dienst staat er dan.
4. Een andere dag, of een andere monteur: geen vraag.

### Weghalen

Verwijder de module in Odoo bij Apps (Verwijderen), of haal de map `dig_planning_unavailability` uit `odoo/addons` en werk de lijst bij.

## Wat getest is, en wat niet

- Zonder Odoo (`bun run test:odoo-addon`, 14 tests met nagebootste Odoo-onderdelen): wanneer er wel en niet gevraagd wordt, wat er gevraagd
  wordt, dat de bevestiging dezelfde actie nog eens doet zonder te vragen, dat het systeem en een bevestigde actie niet onderbroken worden,
  en alleen records met de herkenning van de juiste monteur die echt overlappen. 17 opzettelijke fouten, 16 gevangen; de overlevende
  (een dienst zonder monteurs overslaan) is gelijkwaardig.
- `odoo_addon/dig_planning_unavailability/tests/test_unavailability.py` is een gewone Odoo-test, **niet gedraaid** (er is hier geen Odoo).
- **Nog niet op een echte Odoo 20 gezien:** of de module installeert, of de veldnamen van `planning.slot` kloppen (hij kijkt naar
  `resource_ids` en anders `resource_id`; staat geen van beide in je Odoo, dan schrijft hij een waarschuwing in het Odoo-log en doet niets), en of
  de vraag verschijnt en **Toch inplannen** goed werkt bij slepen in het Gantt-overzicht en bij een nieuwe dienst.
