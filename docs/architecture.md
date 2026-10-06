# Huidige architectuur

## Request- en datastroom

1. **Gebruikersactie**: een gebruiker opent het dashboard, kiest een datum/periode/monteur, opent details of drukt op `Ververs Odoo-data`.
2. **Browser**: `src/routes/index.tsx` rendert de filters en roept met React Query `GET /api/dashboard` aan. De refreshknop roept dezelfde route met `POST` aan.
3. **Serverroute**: `src/routes/api/dashboard.ts` leest alleen vaste queryparameters, haalt de gecachte Odoo-data op en laat `src/lib/appointments.ts` (zonder I/O) de afspraken bouwen en filteren op periode en monteur.
4. **Cache**: `src/lib/cache.ts` gebruikt `withCache('odoo:dig-dashboard', 300, ...)` uit `src/lib/ttl-cache.ts` (in het geheugen van het serverproces). De eerste lezing of een verlopen cache voert de Odoo-leesacties uit; `POST` gebruikt `.refresh()`.
5. **Odoo-gateway**: `src/lib/gateway.server.ts` roept server-side `POST /v1/models/<model>/search_read` aan met het projecttoken (`DIG_GATEWAY_URL`, `DIG_GATEWAY_TOKEN`). De browser ziet geen token, en alleen de gateway kent de Odoo-sleutel.
6. **Odoo**: de gateway voert `search_read` uit op `planning.slot` en `svs.tech.visit`, beperkt tot `company_id = 2` en de toegestane velden van dit project.
7. **Antwoord**: de route combineert slots en bezoeken, zet Odoo-relaties om naar namen en geeft een beperkt JSON-resultaat terug.
8. **Scherm**: React Query levert het antwoord aan `src/routes/index.tsx`, dat kaarten, lege toestanden, foutmeldingen en het detailpaneel rendert.

## Bestanden per stap

| Stap | Bestand(en) | Verantwoordelijkheid |
|---|---|---|
| UI en browserfetch | `src/routes/index.tsx` | React Query, filters, detailpaneel, Odoo-link |
| HTTP API | `src/routes/api/dashboard.ts` | vaste route en queryparameters, foutvertaling (502/503), antwoord samenstellen |
| Afsprakenlogica | `src/lib/appointments.ts` | slots en bezoeken koppelen, status en totalen per afspraak, filters op periode en monteur (puur, getest) |
| Cache | `src/lib/ttl-cache.ts` | `withCache`: TTL, `refresh()`, gedeelde lopende lezing, mislukte lezing wordt niet bewaard |
| Odoo-leeslaag | `src/lib/cache.ts` | vaste Odoo-modellen en veldenlijst, weergavenaam van het bedrijf, TTL van 300 s |
| Gateway-client en serversecret | `src/lib/gateway.server.ts` | gateway-URL en projecttoken uitsluitend server-side |
| Datatypen | `src/lib/dashboard-types.ts` | interne TypeScript-vormen |
| Gezondheid | `src/routes/api/health.ts` | `GET /api/health`: `ok` of `degraded` (503) als de gateway niet is ingesteld; roept Odoo niet aan |
| Tests | `test/appointments.test.ts`, `test/ttl-cache.test.ts` | `bun run test:app`; de testgegevens voor `probe_app` staan in `scripts/demo-data.mjs` |
| Productieserver | `scripts/serve.mjs` | serveert `dist/client` en de TanStack Start server-entry op Node |
| Build | `vite.config.ts`, `package.json` | Vite 8, TanStack Start, Tailwind; geen platformplugins |

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

- Odoo-toegang: Odoo-gateway, `POST /v1/models/<model>/search_read` (Odoo JSON-2 API achter de gateway).
- Methode: uitsluitend `search_read`; de gateway staat geen schrijfmethoden toe.
- Vast bedrijfsfilter: `company_id = 2`, afgedwongen door de gateway-projectconfig (de naam `De Installatiegroep B.V. [TEST]` staat alleen in de weergave).
- Readlimiet: `500` per model (de gateway begrenst met `maxLimit`).
- Dashboardfilters (datum, periode, monteur) worden na de gecachte leesactie in de serverroute toegepast.
- Periode: `day`, `upcoming` of `all`.
- Tijden worden voor weergave naar `Europe/Amsterdam` geïnterpreteerd.
- Bekend probleem: `upcoming` vergelijkt de UTC-starttijd met de Amsterdamse datum, waardoor een afspraak
  vlak na middernacht Amsterdamse tijd op de dag zelf wel onder `day` valt maar niet onder `upcoming`
  (`docs/verification.md`).

## Authenticatie, autorisatie en geheimen

**In deze repository:**

- `DIG_GATEWAY_TOKEN` wordt in `src/lib/gateway.server.ts` uit de server-omgeving gelezen; het bestand heeft een server-only import en mag niet vanuit browsercode worden geïmporteerd.
- De company-afscherming zit in de gateway-projectconfig, niet in de browser of in dit dashboard.
- De route accepteert geen model, endpoint of raw Odoo-body vanuit de browser.

**Buiten deze repository:**

- De Odoo-sleutel staat alleen bij de gateway (`ODOO_API_KEY`), voor een aparte Odoo-gebruiker met leesrechten.
- Toegang tot de preview wordt geregeld door de preview-proxy van de DIG Builder (`sandbox/`).

**Belangrijke beperking:** de applicatie zelf heeft geen gebruikerslogin, sessiecontrole of Odoo-gebruikersautorisatie in deze code. Een productieversie heeft een eigen server-side auth-laag nodig.

## Niet aanwezig

Deze repository bevat geen Odoo-module, Odoo Enterprise-broncode, schrijfroute, berichtendienst, eigen klantdatabase voor dashboardrecords of publicatielogica.
