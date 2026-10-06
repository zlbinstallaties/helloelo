# Odoo-client (alleen voor de gateway)

`src/lib/odoo-client.ts` is een alleen-lezen client voor de Odoo External JSON-2 API
(`POST /json/2/<model>/search_read`, `Authorization: bearer <API-key>`). Hij heeft geen
platformafhankelijkheden en krijgt zijn configuratie van de aanroeper.

**Het dashboard gebruikt deze client niet.** Alleen de gateway (`gateway/src/main.ts` en
`gateway/src/server.ts`) importeert hem; het dashboard leest via de gateway
(`src/lib/gateway.server.ts`, zie `docs/odoo-gateway.md`). De Odoo-sleutel hoort dus alleen bij de
gateway.

## Configuratie

De gateway leest de configuratie uit zijn eigen omgeving (`gateway/src/main.ts`):

| Variabele | Verplicht | Doel |
|---|---|---|
| `ODOO_BASE_URL` | ja | `https://<odoo-host>` (https verplicht, behalve localhost) |
| `ODOO_API_KEY` | ja | API-key van een aparte Odoo-gebruiker met alleen leesrechten |
| `ODOO_DATABASE` | optioneel | `X-Odoo-Database`, nodig bij meerdere databases op één server |
| `ODOO_ALLOWED_HOSTS` | ja, voor de gateway | hosts die de gateway mag aanroepen (de Odoo-testserver); `*.odoo.sh` en `*.odoo.com` worden altijd geweigerd |

## Veiligheid

- Alleen `search_read`, `search_count` en `fields_get`; geen create/write/unlink en geen generieke
  aanroep.
- Modelallowlist en verplicht company-filter (domain + context), vastgelegd bij het aanmaken van de
  client.
- De API-key staat alleen in de Authorization-header en komt niet in foutmeldingen.
- Time-out 15 s, limiet maximaal 1000 records per aanroep.
- De Odoo-gebruiker achter de key bepaalt wat er daadwerkelijk leesbaar is: geef die minimale rechten.

## Tests

`bun run test:odoo` draait de clienttests (11) met een nep-fetch; er is geen Odoo nodig. De gateway-tests
(`bun run test:gateway`) gebruiken een nagebootste client.

## Beperkingen

- De Odoo-API is alleen beschikbaar op Odoo-abonnementen met externe API-toegang; controleer dat voor
  jullie omgeving.
- Paginering boven 500 records ontbreekt in het dashboard; zie `docs/verification.md`.
- De client is alleen met nagebootste antwoorden getest, nog niet tegen de echte Odoo 20-testserver.
