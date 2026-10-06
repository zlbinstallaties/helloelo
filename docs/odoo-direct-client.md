# Odoo-client (alleen voor de gateway)

`src/lib/odoo-client.ts` is een client voor de Odoo External JSON-2 API
(`POST /json/2/<model>/search_read`, `Authorization: bearer <API-key>`). Hij leest, met één vaste uitzondering (zie
hieronder). Hij heeft geen platformafhankelijkheden en krijgt zijn configuratie van de aanroeper.

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

- De algemene methoden zijn alleen `search_read`, `search_count` en `fields_get`; geen create/write/unlink en geen
  generieke aanroep. `hr.employee` en `res.users` staan niet op de modelallowlist en zijn dus niet leesbaar.
- Eén vaste schrijfmethode, `createEmployee`: een `hr.employee` met alleen `name`, `company_id`, `hr_responsible_id`,
  `user_id: false` en `date_version`. Er is geen parameter voor een ander veld, een ander model of een Odoo-gebruiker.
  Een fout met een antwoord van Odoo is `rejected` (er is niets aangemaakt); alles waarbij een bruikbaar antwoord
  ontbreekt is `unknown` (de medewerker kan bestaan). Daarnaast twee vaste leesacties: `checkResponsible` (één
  `res.users`-record, vier velden) en `readEmployee` (één `hr.employee`-record, vijf velden).
- Modelallowlist en verplicht company-filter (domain + context), vastgelegd bij het aanmaken van de
  client.
- De API-key staat alleen in de Authorization-header en komt niet in foutmeldingen.
- Time-out 15 s, limiet maximaal 1000 records per aanroep.
- De Odoo-gebruiker achter de key bepaalt wat er daadwerkelijk leesbaar is: geef die minimale rechten.

## Tests

`bun run test:odoo` draait de clienttests (21, waarvan 10 voor de aanmaakactie) met een nep-fetch; er is geen Odoo nodig. De gateway-tests
(`bun run test:gateway`) gebruiken een nagebootste client.

## Beperkingen

- De Odoo-API is alleen beschikbaar op Odoo-abonnementen met externe API-toegang; controleer dat voor
  jullie omgeving.
- Het dashboard pagineert zelf (`src/lib/paging.ts`, plafond 5000 records per model); zie `docs/verification.md`.
- De client is met nagebootste antwoorden getest en één keer tegen een lokale Odoo 20 Enterprise (zie `docs/verification.md`); nog niet tegen de Odoo 20-testserver.
