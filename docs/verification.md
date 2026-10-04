# Verificatie en beperkingen

## Statusoverzicht

| Controle | Status | Bevinding |
|---|---|---|
| Alleen-lezen Odoo-methoden | Geslaagd voor huidige code | `src/lib/cache.ts` gebruikt alleen `search_read`; er zijn geen `create`, `write` of `unlink` calls in de dashboardroute. |
| Geen berichten | Geslaagd voor huidige code | Geen mail-, chatter- of notificatiecall in de dashboardcode. |
| Odoo-configuratie niet wijzigen | Geslaagd voor huidige code | De dashboardroute leest geen configuratiemodel en schrijft niets. |
| Bedrijfsafscherming | Gedeeltelijk geslaagd | Serverroute en beide Odoo-reads gebruiken `company_id = 2`. Dit is geen vervanging voor gebruikersauthenticatie. |
| Dashboard-app-authenticatie | Niet van toepassing op builder | Het bestaande read-only dashboard blijft zonder eigen login. De DIG Builder-authenticatie zit in de Odoo-addon en gebruikt `auth="user"` plus `dig_builder.group_dig_builder_admin`. |
| DIG Builder-authenticatie | Code toegevoegd, integratietest open | Odoo-routes controleren bij iedere aanvraag de expliciete admin-groep; niet-ingelogde en niet-beheerders worden geweigerd. Dit is nog niet tegen de echte Odoo-testserver uitgevoerd. |
| Geheimen in browsercode | Geslaagd op code-inspectie | Proxy en `HELLOLEO_API_KEY` staan in server-only code. Geen sleutelwaarde staat in broncode. |
| Secretbestanden | Gedeeltelijk geslaagd | `.env` is aanwezig en wordt door `.gitignore` uitgesloten; er is een lokale `HELLOLEO_API_KEY` aangetroffen. De waarde is niet in documentatie of nieuwe bestanden gekopieerd. Git-tracking van dit bestand is niet met `git status` geverifieerd. |
| Many2many-monteurs | Gedeeltelijk / niet volledig bewezen | `employee_ids` en `user_ids` worden gelezen en defensief naar namen omgezet. De previewrecords hadden geen toegewezen medewerkers, waardoor een echte toegewezen many2many-case niet is getest. De filter is naamgebaseerd en kan bij gelijke namen botsen. |
| Meerdere bezoeken per afspraak | Mislukt | `visitsBySlot` is een `Map<number, visit>` en bewaart maximaal één bezoek per slot. De UI toont dus niet alle bezoeken als één slot meerdere `svs.tech.visit`-records heeft. |
| Datum/tijdzone | Gedeeltelijk geslaagd | Slotdatums worden server-side naar `Europe/Amsterdam` omgerekend en tijden worden zo weergegeven. De Odoo-datetime-aanname (`UTC`-interpretatie) en `upcoming`-vergelijking zijn niet met DST-randgevallen getest. |
| Odoo-limiet 500 | Bekende beperking | Beide reads gebruiken `limit: 500`, `offset: 0`; er is geen paginering. Dat is onvoldoende voor grotere omgevingen. |
| Odoo-foutafhandeling | Gedeeltelijk geslaagd | Proxyfouten worden server-side naar HTTP 502 vertaald en de UI toont een foutstaat. De refreshactie controleert haar eigen HTTP-status niet expliciet en de API geeft geen volledige upstream-foutdiagnostiek terug. |
| Lege toestand | Geslaagd | Een datum zonder resultaten geeft een lege toestand met opties voor komende of alle afspraken. |
| `TV/0001` | Geslaagd | Preview-API gaf `TV/0001`, status `in_progress`, één ontbrekend verplicht onderdeel en nul foto’s terug. |
| Preview HTTP smoke test | Geslaagd | Hoofdpagina en `/api/dashboard` antwoordden HTTP 200; POST-refresh antwoordde HTTP 200. |
| Backend previewlogs | Geslaagd voor runtimefouten | Geen backend-runtimefout aangetroffen. Historische iframe/HMR-meldingen blijven in de loghistorie staan. |
| Typecheck | Niet uitvoerbaar in deze sessie | Geen shell/CLI-tool was beschikbaar om `bun run typecheck` uit te voeren. |
| Build/lint | Niet uitvoerbaar in deze sessie | Geen shell/CLI-tool was beschikbaar om `bun run build` of lint uit te voeren. |
| Builder-tests | Lokale run rapporteerde 17 tests, 1 failure en 2 errors; reparatie voorbereid | De testopzet gebruikt uitsluitend de geconfigureerde interne builder-service, geeft de positieve routegebruiker Planning-leesrechten en controleert JSON-RPC-authenticatiefouten. Deze workspace heeft Docker/Odoo niet beschikbaar; de reparatie is hier niet uitgevoerd. |
| OpenAI nested output extraction | Toegevoegd, niet uitgevoerd | Regressietests dekken nested `output_text`, meerdere blokken, lege/afgebroken antwoorden en providerfouten. |
| Metadata-to-proposal contract | Code toegevoegd, niet uitgevoerd | Odoo maakt `odoo20-v1` met allowlisted models/fields en de service valideert en gebruikt dit in de providerprompt. |
| Protected ORM workflow fields | Code toegevoegd, niet uitgevoerd | `create`, `write` en `copy` weigeren directe state-, phase-, proposal-, metadata-, hash- en servicevelden; alleen private workflowmethoden schrijven ze. |
| Odoo 20 field compatibility | MCP-schema gecontroleerd | Deze sessie bevestigde `res.groups.privilege_id`, `res.users.group_ids`, `res.users.all_group_ids`, model `has_access("read")`, model `ir.access` en `ir.config_parameter.get_str()`/`set_str()`; addon-installatie is nog niet uitgevoerd. |
| Git-status | Niet uitvoerbaar via Git-tool | Er is geen Git-status/commit/push-tool beschikbaar in deze sessie. Er is niet gecommit en niet gepusht. |

## Aanbevolen vervolgreparaties

1. Voeg echte server-side app-authenticatie en rollen toe voordat het dashboard buiten de HelloLeo-preview wordt gebruikt.
2. Modelleer monteurselectie met stabiele Odoo-ids en maak een gecontroleerde employee/user-relatie.
3. Maak een afspraak één-op-veel voor bezoeken en render alle bezoekformulieren.
4. Voeg server-side paginering of een datumgebonden Odoo-domain toe vóór datasets boven 500 records.
5. Gebruik een expliciete timezone-helper met DST-tests voor filters en sortering.
6. Controleer refreshfouten in de browser en geef een traceerbare maar secretvrije foutcode terug.
7. Voeg unit tests toe voor mapping, multi-visit, multi-company, paginering en tijdzonegrenzen.
