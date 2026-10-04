# DIG Builder fase 2

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

## API-flow

1. `GET /api/providers` reports whether each provider has both a server-side credential and model configured.
2. `POST /api/projects` with `description`, `provider`, and `model` creates a draft.
3. `POST /api/projects/{id}/proposal` asks only the selected provider for a planning proposal and stores it.
4. `GET /api/projects/{id}` reads the draft or proposal state.

Every endpoint except `/healthz` requires `Authorization: Bearer $BUILDER_ADMIN_TOKEN`. The proposal endpoint is intentionally not a build, test, preview, or install operation.
- Runner is bereikbaar via healthcheck maar uitvoering is bewust uitgeschakeld.
- Odoo-addon-skelet `dig_builder` met expliciete groep `DIG Builder Administrator`.
- Odoo-model `dig.builder.project` met server-side groepscontrole op goedkeuring.
- Bestaande monteursdashboardcode is niet gewijzigd.

## Niet geïmplementeerd

- Chatinterface.
- Metadata-backed proposal context beyond the read-only model inventory.
- Geïsoleerde code-uitvoering.
- Bestandsdiffs, testsandbox, preview en installatiepakket.
- Echte OpenAI- of Anthropic-end-to-endtest; credentials ontbreken.
- Odoo-addon-installatie en Odoo-testservercontrole.
- Database-backed auditlog met redactie van gevoelige waarden.

## Veiligheidsgrens

De runner-image bevat geen Docker-socket, geen Odoo-credentials en geen code-executie-endpoint. De API logt geen requestbody, prompts, provideroutput of authorization-header. Odoo bepaalt gebruiker, company-context en goedkeuring; de builder-service accepteert alleen de interne service-token. Voorstelgeneratie gebruikt alleen de expliciet gekozen provider en slaat provideroutput op als voorstel; het voert geen code uit. De JSON-store is geschikt voor de scaffoldfase, niet voor meerdere API-processen of productiegebruikers.
