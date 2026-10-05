# HelloLeo: hoe het werkt (onderzoek)

Bron: helloleo.dev en docs.helloleo.dev (openbaar), onderzocht op 2026-10-05.
De interne werking van de AI-agent en de sandbox is niet openbaar; dat staat hier dus niet in.

## Kern
HelloLeo is geen Odoo-module. Het is een platform dat losse web-apps bouwt naast een ERP
(Odoo, NetSuite, Salesforce e.a.) en die publiceert op `naam.helloleo.app` of een eigen domein.

## Werking
1. Koppelen: Odoo-URL, database, gebruiker en API-key; versleuteld aan serverkant opgeslagen.
2. Context lezen: Leo leest eerst modellen, custom velden en rollen.
3. Bouwen: chat beschrijft wat je wilt; frontend, backend en koppelingen in een keer; live preview.
4. Publiceren: bouwt het project en deployt; de gepubliceerde versie blijft stabiel tot "Update Published Version".

## Onderdelen
- Middleware/proxy: alle Odoo-aanroepen van de app lopen via hun server, die de credentials toevoegt.
- Generieke Odoo-tool `execute_method(model, method, args, kwargs)`: kan alles, ook write en unlink.
- Kennis: `LEO_RULES.md` per project plus korte memories.
- HelloLeo Cloud: database, bestandsopslag en secrets per app.
- Agents: rechten per model en per methode; modus "alleen eigen data" voor klantportalen.
- Git: GitHub/GitLab via SSH, branches en versiegeschiedenis.
- Staging met automatische backups; productie na goedkeuring (volgens hun site).
- Network Monitor: toont wat de app naar de systemen stuurt.
- HelloLeo MCP: dezelfde toolset als remote MCP-server voor externe clients.

## Verschil met onze aanpak
- Zij: generieke `execute_method`. Wij: allowlist per model en methode (`odoo-client.ts`).
- Zij: credentials van een admin/technische gebruiker. Wij: aparte leesgebruiker met minimale rechten.
