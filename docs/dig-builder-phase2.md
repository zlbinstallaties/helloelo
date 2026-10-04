# DIG Builder fase 2

## Gewijzigde bestanden

- `builder/build-service/providers.py`, `server.py`, `store.py`: providerextractie, metadata-validatie, promptcontract, bounded output en metadata-opslag.
- `builder/build-service/test_providers.py`, `test_service.py`: provider- en service-regressietests.
- `builder/odoo_addon/dig_builder/models/builder_project.py`: Odoo 20-model, metadata-contract, workflowtransities en server-side builder-servicecall.
- `builder/odoo_addon/dig_builder/controllers/builder.py`: Odoo `jsonrpc`-routes voor metadata en projecten.
- `builder/odoo_addon/dig_builder/security/security.xml`, `security/ir.access.csv`: Odoo 20 privilege/group en beperkte company-scoped toegang.
- `builder/odoo_addon/dig_builder/views/dig_builder_project_views.xml`: beheerinterface en expliciete unavailable-status voor bouwen/publiceren.
- `builder/odoo_addon/dig_builder/tests/`: addon security-, metadata- en HTTP-tests.
- `builder/odoo_addon/dig_builder/tests/test_security.py`: create/write/copy rejection and mocked service workflow regressions.
- `docker-compose.yml`, `.env.example`, `docs/verification.md`: bounded providerconfiguratie, interne servicegrens en verificatiestatus.

## Geimplementeerd

- Onafhankelijke `docker-compose.yml` met `builder-api` en `runner`.
- Server-side admin tokencontrole op builder API-acties.
- Persistente fase-2 JSON-store onder de gemounte builderdata-volume.
- Providerstatus voor OpenAI en Anthropic zonder geheime waarden terug te geven.
- Expliciete provider-connectiviteitstest via OpenAI Responses API of Anthropic Messages API.
- Geen automatische providerfallback.
- Provider ontbreekt: HTTP 503 met `provider_not_configured`.
- Admin-only project creation, retrieval, and explicit proposal generation endpoint.
- Proposal output is stored as `proposed`; no generated code is executed.
- Odoo controller routes use the existing Odoo session and enforce `dig_builder.group_dig_builder_admin` server-side on every action and metadata request.
- Odoo forwards to the builder service server-side; the builder service has no published Compose host port.
- Company record rules and explicit `Connect -> Describe -> Build -> Publish` phase tracking.
- Addon/service tests cover unauthenticated access, non-admin rejection, admin access, company isolation, invalid service authentication, provider failures, and secret non-disclosure.
- OpenAI Responses extraction reads nested `output_text` blocks, joins multiple blocks, rejects incomplete responses, and uses bounded `PROPOSAL_MAX_OUTPUT_TOKENS`.
- Odoo 20 metadata contract `odoo20-v1` contains only an allowlisted model/field schema, current company id, field types, and relations; it never contains records or secrets.
- Metadata is included in the provider prompt as data, validated again by the builder service, and its version is stored with the project.
- Proposal approval is invalidated when description, provider/model selection, or metadata changes. Build execution and publishing remain unavailable.
- Public ORM `create`, `write`, and `copy` cannot set workflow-managed fields. Protected fields are written only by private, checked workflow methods; context values cannot bypass this boundary.
- Odoo 20 Enterprise-beveiliging gebruikt `ir.access` met alleen de DIG Builder-beheerdersgroep en de company-domain `[('company_id', 'in', company_ids)]`; de serviceconfiguratie gebruikt server-side `get_str()`/`set_str()`.
- De metadata-contractroute gebruikt uitsluitend modelgebonden `fields_get()` voor de allowlist onder de huidige gebruiker; zij leest niet de volledige `ir.model.fields`-catalogus en gebruikt hiervoor geen `sudo()`.
- De integratietest laat alleen de exact geconfigureerde interne `GET /api/providers`-serviceaanroep door; andere bestemmingen blijven onder de Odoo-testblokkade en redirects worden niet gevolgd.

## API-flow

1. `GET /api/providers` reports whether each provider has both a server-side credential and model configured.
2. `POST /api/projects` with `description`, `provider`, `model`, and validated `odoo20-v1` metadata creates a draft.
3. `POST /api/projects/{id}/proposal` asks only the selected provider for a planning proposal and stores it.
4. `GET /api/projects/{id}` reads the draft or proposal state.

Every endpoint except `/healthz` requires `Authorization: Bearer $BUILDER_ADMIN_TOKEN`. The proposal endpoint is intentionally not a build, test, preview, or install operation.
- Runner is bereikbaar via healthcheck maar uitvoering is bewust uitgeschakeld.
- Odoo-addon-skelet `dig_builder` met expliciete groep `DIG Builder Administrator`.
- Odoo-model `dig.builder.project` met server-side groepscontrole op goedkeuring.
- Bestaande monteursdashboardcode is niet gewijzigd.

## Niet geïmplementeerd

- Chatinterface.
- A richer metadata-backed proposal context beyond the read-only allowlisted schema.
- Geïsoleerde code-uitvoering.
- Bestandsdiffs, testsandbox, preview en installatiepakket.
- Echte OpenAI- of Anthropic-end-to-endtest; credentials ontbreken.
- Odoo-addon-installatie en Odoo-testservercontrole zijn afhankelijk van de lokale Odoo 20 Enterprise-integratierun.
- Database-backed auditlog met redactie van gevoelige waarden.
- Testexecution in this workspace; the addon requires an actual Odoo 20 test database and the service tests require the Python test runner.

## Veiligheidsgrens

De runner-image bevat geen Docker-socket, geen Odoo-credentials en geen code-executie-endpoint. De API logt geen requestbody, prompts, provideroutput of authorization-header. Odoo bepaalt gebruiker, company-context en goedkeuring; de builder-service accepteert alleen de interne service-token. Metadata en beschrijving worden als onbetrouwbare data aan de provider aangeboden en kunnen geen rechten uitbreiden. Voorstelgeneratie gebruikt alleen de expliciet gekozen provider en slaat provideroutput op als voorstel; het voert geen code uit. De JSON-store is geschikt voor de scaffoldfase, niet voor meerdere API-processen of productiegebruikers.
