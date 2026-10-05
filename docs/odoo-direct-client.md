# Directe Odoo-client (zonder HelloLeo-proxy)

`src/lib/odoo-client.ts` is een alleen-lezen client voor de Odoo External JSON-2 API
(`POST /json/2/<model>/search_read`, `Authorization: bearer <API-key>`).
`src/lib/odoo.server.ts` leest de configuratie uit server-env.

## Configuratie

| Variabele | Verplicht | Doel |
|---|---|---|
| `ODOO_BASE_URL` | ja | `https://<odoo-host>` (https verplicht, behalve localhost) |
| `ODOO_API_KEY` | ja | API-key van een aparte Odoo-gebruiker met alleen leesrechten |
| `ODOO_DATABASE` | optioneel | `X-Odoo-Database`, nodig bij meerdere databases op één server |

Zijn `ODOO_BASE_URL` en `ODOO_API_KEY` niet gezet, dan gebruikt `cache.ts` nog de HelloLeo-proxy.

## Veiligheid

- Alleen `search_read`; geen create/write/unlink en geen generieke aanroep.
- Modelallowlist (`planning.slot`, `svs.tech.visit`) en verplicht company-filter (domain + context).
- De API-key staat alleen in de Authorization-header en komt niet in foutmeldingen.
- Time-out 15 s, limiet maximaal 1000 records per aanroep.
- De Odoo-gebruiker achter de key bepaalt wat er daadwerkelijk leesbaar is: geef die minimale rechten.

## Tests

`bun run test:odoo` (of `npm run test:odoo`) draait de clienttests met een nep-fetch; er is geen Odoo nodig.

## Nog niet vervangen

- `@helloleo/runtime`: `withCache` (5 min TTL), `env`, KV, storage en database.
- Applicatie-authenticatie voor het dashboard.
- Paginering boven 500 records.
- De Odoo-API is alleen beschikbaar op Odoo-abonnementen met externe API-toegang; controleer dat voor jullie omgeving.
