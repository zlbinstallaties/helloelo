# Zichtbare bouwworkflow

## Daadwerkelijk uitgevoerd

1. De verbonden Odoo 20-testomgeving is via de beschikbare Odoo-leesfunctie onderzocht met `search_read` op modelmetadata, veldmetadata en beperkte recordsteekproeven.
2. De bedrijfsrecord `De Installatiegroep B.V. [TEST]` is als `res.company` met id `2` geverifieerd.
3. CRM, verkoop, planning, projecten, DIG-bezoekmodellen en standaard commissiemodellen zijn onderzocht zonder `create`, `write` of `unlink`.
4. Een TanStack Start-project is met de projectscaffold aangemaakt omdat er nog geen `package.json` of bronapplicatie aanwezig was.
5. De bestaande proxy-helper, cache-sjabloon, routes, runtimeconfiguratie en styles zijn gelezen voordat code is toegevoegd.
6. De serverroute is opgebouwd met vaste Odoo-modellen en `search_read`, een vaste company-domain en een cache-levensduur van vijf minuten.
7. De dashboardpagina is gebouwd met React Query, filters, detailweergave, lege/fout/laadtoestand en een alleen-lezen Odoo-link.
8. De preview is opnieuw gestart met de preview-debugfunctie nadat er nog geen preview-URL was.
9. De preview is gecontroleerd met HTTP GET op de hoofdpagina, GET op `/api/dashboard` voor de dag van `TV/0001`, POST-refresh en een datum zonder bezoeken.
10. Previewlogs zijn gecontroleerd. Er was geen backend-runtimefout; een oude HMR-CSS-melding en een eerder React-keywaarschuwing kwamen wel voor in de loghistorie.

## Gebruikte zichtbare tools

- `odoo_execute_method`: read-only Odoo-modelmethoden uitvoeren.
- `glob`: bestanden en mappen zoeken.
- `grep`: broninhoud zoeken.
- `read`: bestanden lezen.
- `apply_patch`: bestanden gericht wijzigen.
- `scaffold`: een standaard TanStack Start-project initialiseren.
- `skill(cache)`: cacheworkflow met zichtbare TTL en refresh gebruiken.
- `helloleo_get_project`: preview/deploystatus en recente fouten bekijken.
- `helloleo_debug_restart_preview`: een vastgelopen of nog niet gestarte preview herstarten.
- `helloleo_debug_inspect_preview_logs`: recente previewfouten bekijken.
- `inspect_http`: HTTP-status, headers en antwoord van previewroutes controleren.

## Voorgestelde overdrachtsworkflow

1. Leg de Odoo-modelanalyse vast voordat code wordt geschreven.
2. Houd alle integratiecalls in serverroutes en geef de browser alleen een beperkt, getypeerd antwoord.
3. Definieer een expliciete staleness budget voor elke dure read en bied altijd een zichtbare refresh.
4. Voeg unit- en routecontracttests toe voordat een nieuwe Odoo-versie of custom veldmapping wordt gebruikt.
5. Controleer preview, foutlogs en representatieve records in de testomgeving.
6. Controleer secrets en klantdata vóór commit.
7. Laat een beheerder reviewen, committen en via de gekoppelde repository synchroniseren.

Deze sectie beschrijft een werkwijze, geen bewijs dat alle voorgestelde stappen al zijn uitgevoerd.
