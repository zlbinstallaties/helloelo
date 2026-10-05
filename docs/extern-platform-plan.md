# Plan: eigen HelloLeo-achtig platform (externe aanpak)

Keuze: losse web-apps die via een eigen gateway met Odoo praten, geen Odoo-addon.

## Onderdelen
1. Builder-app (chat) in TanStack Start: chat, preview en diff naast elkaar.
2. Agent-service: Claude API met tool use (`read_file`, `write_file`, `edit_file`, `run_check`,
   `odoo_schema` alleen-lezen).
3. Sandbox per project: container met de dashboard-template, zonder Odoo-keys, preview-URL achter login.
4. Odoo-gateway: bouwt voort op `src/lib/odoo-client.ts`; allowlist van modellen, velden en methoden
   per project; houdt de credentials vast; logt elke aanroep.
5. Git en publicatie: een repo per app, agent werkt op een feature-branch, publiceren na goedkeuring.
6. `RULES.md` per project (huisstijl, Odoo 20-veldnamen, Nederlandse teksten).

## Veiligheidsregels
- Standaard alleen-lezen; schrijven per model en methode met bevestigingsstap.
- Ontwikkelen tegen de Odoo-testdatabase; productie pas na goedkeuring.
- Een app krijgt een eigen gateway-token met beperkte rechten, nooit de Odoo-key.
- Gegenereerde apps hebben altijd login (bijv. Odoo-SSO).
- Nooit pushen naar `main`/`master`; alleen feature- of staging-branches.

## Fasering
1. Gateway met allowlist per project en schema-endpoint, met tests. **Gebouwd:** `gateway/`, zie `docs/odoo-gateway.md`.
2. Agent-loop op een lokale werkmap; resultaat is een diff op een branch. **Gebouwd:** `agent/`, zie `docs/dig-builder-agent.md`.
3. Sandbox en live preview.
4. Publiceren en login.
5. Schrijfacties naar Odoo.

## Hosting
Eigen server (bijv. VPS met Docker); sandboxes draaien niet op Vercel.
