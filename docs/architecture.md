# Huidige architectuur

## Request- en datastroom

1. **Gebruikersactie**: een gebruiker opent het dashboard, kiest een datum/periode/monteur, opent details of drukt op `Ververs Odoo-data`.
2. **Browser**: `src/routes/index.tsx` rendert de filters en roept met React Query `GET /api/dashboard` aan. De refreshknop roept dezelfde route met `POST` aan.
3. **Serverroute**: `src/routes/api/dashboard.ts` leest alleen vaste queryparameters, haalt de gecachte Odoo-data op, filtert server-side op periode en monteur en bouwt het dashboardantwoord.
4. **Cache**: `src/lib/cache.ts` gebruikt `withCache('odoo:dig-dashboard', 300, ...)`. De eerste lezing of een verlopen cache voert de Odoo-leesacties uit; `POST` gebruikt `.refresh()`.
5. **HelloLeo Proxy**: `src/lib/proxy.server.ts` stuurt server-side een vaste request naar de Odoo Integration Proxy. De browser ziet de API-sleutel niet.
6. **Odoo**: de proxy voert `search_read` uit op `planning.slot` en `svs.tech.visit`.
7. **Antwoord**: de route combineert slots en bezoeken, zet Odoo-relaties om naar namen en geeft een beperkt JSON-resultaat terug.
8. **Scherm**: React Query levert het antwoord aan `src/routes/index.tsx`, dat kaarten, lege toestanden, foutmeldingen en het detailpaneel rendert.

## Bestanden per stap

| Stap | Bestand(en) | Verantwoordelijkheid |
|---|---|---|
| UI en browserfetch | `src/routes/index.tsx` | React Query, filters, detailpaneel, Odoo-link |
| HTTP API | `src/routes/api/dashboard.ts` | vaste route, server-side filtering, samenvoegen van records |
| Odoo-leeslaag/cache | `src/lib/cache.ts` | vaste Odoo-modellen, velden, company-domain, TTL |
| Proxy en serversecret | `src/lib/proxy.server.ts` | HelloLeo Proxy, `HELLOLEO_API_KEY` uitsluitend server-side |
| Datatypen | `src/lib/dashboard-types.ts` | interne TypeScript-vormen |
| Runtime-entry | `src/server.ts` | TanStack Start Worker-entry en foutgrens |
| Build | `vite.config.ts`, `package.json` | HelloLeo Vite-config, scripts en dependencies |

## Odoo-modellen en relaties

De huidige code leest met `search_read`:

- `planning.slot`: `id`, `name`, `start_datetime`, `end_datetime`, `allocated_hours`, `role_id`, `user_ids`, `employee_ids`, `partner_id`, `partner_name`, `partner_address`, `sale_order_id`, `sale_line_id`, `state`, `svs_tech_visit_ids`, `travel_time_in`, `travel_time_out`, `travel_times_up_to_date`.
- `svs.tech.visit`: `id`, `name`, `state`, `visit_date`, `partner_id`, `technician_id`, `template_id`, `slot_id`, `task_id`, `is_complete`, `is_sent`, `missing_required_count`, `missing_required_inputs_count`, `photo_count`, `photo_ids`, `notes`.

In de eerdere Odoo-modelinspectie zijn daarnaast de relaties geverifieerd:

- `planning.slot` verwijst naar klant, rol, gebruikers/medewerkers, verkooporder/-regel en technische bezoeken.
- `svs.tech.visit` verwijst naar klant, technicus, template, planning-slot en historische taak.
- `project.task` heeft verwijzingen naar project, klant, gebruikers, verkooporder/-regel en `svs.tech.visit`, maar wordt in dit dashboard niet als planning gebruikt.
- Standaard commissiemodellen bestaan in Odoo, maar er waren geen commissieplannen/prestaties en ze zijn niet in het dashboard opgenomen.

## Filters en methoden

- Odoo endpoint: `/jsonrpc` via HelloLeo Proxy.
- Odoo-methode: uitsluitend `search_read`.
- Vast bedrijfsfilter: `company_id = 2`, met de naam `De Installatiegroep B.V. [TEST]`.
- Odoo-readlimiet: `500` per model, met `offset: 0`.
- Dashboardfilters (datum, periode, monteur) worden na de gecachte leesactie in de serverroute toegepast.
- Periode: `day`, `upcoming` of `all`.
- Tijden worden voor weergave naar `Europe/Amsterdam` geïnterpreteerd.

## Authenticatie, autorisatie en geheimen

**In deze repository:**

- `HELLOLEO_API_KEY` wordt in `src/lib/proxy.server.ts` uit server-environment gelezen.
- Het bestand heeft een server-only import en mag niet vanuit browsercode worden geïmporteerd.
- De company-afscherming is server-side en niet afhankelijk van browserfilters.
- De route accepteert geen model, endpoint of raw Odoo-body vanuit de browser.

**Buiten deze repository:**

- HelloLeo injecteert project-/omgevingstoegang en beschermt de preview volgens het platform; de concrete middleware en preview-authenticatie staan niet in deze code.
- Odoo-credentials worden door de verbonden HelloLeo-integratie beheerd; ze staan niet in de repository.

**Belangrijke beperking:** de applicatie zelf heeft geen gebruikerslogin, sessiecontrole of Odoo-gebruikersautorisatie in deze code. Een productieversie heeft een eigen server-side auth-laag nodig.

## Niet aanwezig

Deze repository bevat geen Odoo-module, Odoo Enterprise-broncode, schrijfroute, berichtendienst, eigen klantdatabase voor dashboardrecords of publicatielogica.
