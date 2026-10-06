# Accounts en inloggen voor het dashboard

Monteurs krijgen een eigen account dat een admin aanmaakt, en zien alleen hun eigen afspraken uit de
Odoo-planning. Er wordt niets naar Odoo geschreven en er worden geen Odoo-gebruikers aangemaakt.

> **Stand (2026-10-06): etappe 1 van 3.** De kern is gebouwd en getest, maar **nog niet aangesloten** op de
> routes en het scherm. Het dashboard zelf vraagt dus nog steeds niet om een login. Etappe 2 (schermen en
> aansluiting) en etappe 3 (platform) staan onderaan.

## Uitgangspunten

- Een admin maakt accounts aan; er is geen registratie. De admin koppelt elk monteursaccount aan een **persoon
  uit de Odoo-planning** (een medewerker, zoals die in `planning.slot` staat). Zo zien we de monteur in de
  planning, zonder dat het dashboard iets in Odoo aanmaakt.
- Voor zover wij weten telt in Odoo een medewerker zonder inlog niet mee voor het aantal betaalde gebruikers.
  Controleer dat voor jullie abonnement voordat monteurs als medewerker worden aangemaakt.
- Een monteur ziet alleen afspraken waar de gekoppelde persoon aan is toegewezen, mét collega's die dezelfde
  afspraak hebben. Een monteur zonder persoon, of met een persoon die nergens is ingepland, ziet niets (nooit alles).
- Een monteur krijgt **geen links naar Odoo** (hij heeft er geen account), kan **niet zelf vernieuwen** (een
  vernieuwing kost tot 10 leesaanroepen bij Odoo) en kan geen accounts beheren. Een admin ziet alles.

## Onderdelen (`src/lib/`, zonder I/O, getest in `test/`)

| Bestand | Verantwoordelijkheid |
|---|---|
| `password.ts` | scrypt-hash in hetzelfde formaat als de preview-proxy (`scrypt:<zout>:<hash>`), wachtwoordregel (12 tot 200 tekens), leesbaar gegenereerd wachtwoord |
| `sessions.ts` | getekende sessiecookie (12 uur), cookie-opties (`HttpOnly`, `SameSite=Strict`, `Secure`), beperking van mislukte pogingen |
| `accounts.ts` | accountopslag: aanmaken, wijzigen, wachtwoord resetten, verwijderen, controleren van gebruikersnaam en wachtwoord |
| `auth.ts` | inloggen, sessie omzetten naar persoon, eigen wachtwoord wijzigen, het noodaccount |
| `authorization.ts` | wie ziet welke afspraken en wie mag wat |
| `appointments.ts` | `personHasId`: een persoon met de ids waaronder hij bekend is |

## Beveiligingseigenschappen

- Alleen een hash wordt bewaard. Een account wordt nooit teruggegeven mét hash.
- Een sessie noemt het account en een **sessieversie**. Uitschakelen, een andere rol of persoon, of een nieuw
  wachtwoord verhoogt de versie, waardoor alle sessies van dat account meteen eindigen. Opnieuw inschakelen
  brengt een oude sessie niet terug.
- Mislukte pogingen worden geteld per clientadres én per gebruikersnaam. Een geslaagde login wist alleen de
  teller van die gebruikersnaam, zodat een geldig account niet kan dienen om een aanval te resetten. Gevolg:
  iemand kan een gebruikersnaam 15 minuten blokkeren door er vaak naast te raden.
- Onbekende gebruiker, fout wachtwoord en uitgeschakeld account krijgen hetzelfde antwoord en kosten dezelfde tijd.
- Een kapot accountbestand is een fout en wordt nooit stil "leeg" gemaakt; dat zou alle accounts wissen.
- **Noodaccount:** een admin uit de serverinstellingen (`DIG_ADMIN_USERNAME`, `DIG_ADMIN_PASSWORD_HASH`), niet uit
  het accountbestand. Hij werkt ook als dat bestand kapot is en kan niet via het scherm worden gewijzigd. De hash
  maak je met `bun run preview:password '<wachtwoord>'`.

## Koppeling met de planning en de beperking daarvan

Een account hangt aan een persoon-id zoals `employee:7`. Een gebruiker en een medewerker zijn in Odoo
verschillende records; ze gelden alleen als één persoon als één planning ze onder dezelfde naam noemt.
Daarom onthoudt een persoon ook de andere ids waaronder hij bekend is (`alsoIds`), zodat een koppeling niet
stilletjes breekt als de planning hem later onder een ander id noemt.

Beperking: de technicus van een **bezoek** is een Odoo-gebruiker. Heeft een monteur geen Odoo-gebruiker (dat is
hier de bedoeling), dan komt hij alleen via de planning in beeld (`employee_ids` van de afspraak). Een bezoek
zonder planning heeft dan geen persoon en is alleen voor admins zichtbaar.

## Wat er nog moet (zie de etappes)

2. **Schermen en aansluiting:** inlogscherm, uitloggen, beheerscherm (monteur aanmaken en koppelen aan een
   persoon, wachtwoord resetten, uitschakelen, verwijderen), `/api/dashboard` alleen met sessie, `POST` alleen
   voor admins, CSRF-controle, accountbestand op schijf (`DIG_DATA_DIR`).
3. **Platform** (verandert de beveiligingsgrenzen van de sandbox, daarom pas na akkoord): een gepubliceerd
   dashboard draait nu alleen-lezen zonder blijvende opslag en achter één gedeeld wachtwoord van de proxy. Voor
   eigen accounts is nodig: een blijvende schrijfbare map per project, een sessiegeheim als omgevingsvariabele,
   en de gedeelde proxy-login niet vóór het dashboard.
