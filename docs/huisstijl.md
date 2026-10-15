# Huisstijl van het dashboard

Het dashboard gebruikt de kleuren, de lettertypen en het logo van **De Installatiegroep**, zoals die in Claude Design staan: de tokens van het ontwerpsysteem
(licht en donker, uit de audit *De Installatiegroep Design System*), en het logo uit het **Logopakket De Installatiegroep** dat het bedrijf zelf
aanleverde. Kleuren en lettertypen staan op één plek: `src/styles.css`. Pas je daar een token aan, dan verandert het overal.

## Kleuren

| Token | Licht | Donker | Waarvoor |
|---|---|---|---|
| `--background` | `#F7F5F1` papier | `#0A121C` | pagina |
| `--foreground` | `#16283C` inkt | `#F7F5F1` | tekst |
| `--card`, `--popover` | `#FFFFFF` | `#16283C` | kaarten en menu's |
| `--primary` | `#16283C` | `#F7F5F1` | knoppen, actieve tab |
| `--secondary`, `--muted` | `#F0EDE6` | `#101B28` | rustige vlakken |
| `--muted-foreground` | `#4E6B87` | `#B9C6D2` | bijtekst |
| `--accent` | `#F6EBDD` koper zacht | `#2C2117` | hover en selectie |
| `--destructive` | `#B00020` | `#F0788C` | fouten en verwijderen |
| `--ring` | `#B87333` | `#CA8E56` | focus |
| `--copper` | `#9F6229` | `#CA8E56` | koper als tekst (leesbaar) |
| `--seam` | `#B87333` | `#CA8E56` | de koperen lijn en punt van het logo |
| `--chart-1` ... `--chart-5` | koper, `#4E6B87`, groen `#1E6B4F`, oker `#8A6116`, `#7A8FA3` | koper, `#B9C6D2`, `#6FBF97`, `#E0B45C`, `#8298AC` | accenten en waarschuwingen |

Het logo gebruikt `--seam` (de koperen staaf) en `--foreground` (de D en het woordmerk), dus het juiste kleurvariant van het logopakket
verschijnt vanzelf: licht is *kleur* (koper `#B87333`, navy `#16283C`), donker is *inverse* (koper `#CA8E56`, off-white `#F7F5F1`).
Gebruik in componenten altijd de tokens (`bg-background`, `text-seam`, ...) en nooit een hex.

## Lettertypen

**Fraunces** voor koppen, **Inter** voor tekst. (Het woordmerk in het logo is Inter Medium als contouren; dat zit in het logo zelf.) Ze komen **mee met de app**
(`@fontsource-variable/fraunces` en `@fontsource-variable/inter`, geladen in `src/styles.css`); er gaat geen verzoek naar een
lettertypedienst, en dat is bewust zo: de pagina werkt ook achter een firewall en laat geen gegevens naar derden lekken.

## Logo

Het logo is de **horizontale lock-up** uit het Logopakket De Installatiegroep: een koperen staaf en een navy "D" (twee halve cirkels), en het
woord "De Installatiegroep" (*De* klein, *Installatiegroep* groot) in Inter Medium, omgezet naar contouren (dus geen lettertype nodig).

- `src/lib/documents/logo.ts`: de vorm (de staaf, de D, de contouren van het woordmerk). Eén bron voor het scherm én het PDF, zonder
  afhankelijkheden; met tests (`test/documents-logo.test.ts`). Een ander logo is een wijziging in dit ene bestand.
- `src/components/logo.tsx`: `Logo` (de lock-up, minstens 44 px hoog = 197 px breed; het pakket vraagt minstens 180 px) en `LogoMark` (alleen het
  teken, voor plekken onder 120 px). Kleuren via tokens, in licht en donker vanzelf het goede variant.
- `public/favicon.svg`: het teken in de inverse kleuren op een navy tegel (een app-icoon), zodat het op een lichte en een donkere tabbalk leesbaar is. Dit
  is afgeleid van het monogram uit het pakket; de tegel zelf staat niet in het pakket.
- Het PDF (`drawLogo` in `src/lib/documents/render.ts`) tekent dezelfde lock-up als gevulde vormen, in de kleur-variant (navy en koper) op wit.

Het logo staat in de kop van elke pagina, boven het inlogscherm en in de briefkop van het PDF. Gebruik de regels van het pakket: vrije ruimte rond het
logo van 4 × de breedte van de koperen staaf, en het teken alleen voor kleine formaten.

## Wat bewust anders is dan in Claude Design

- De hoekradius is `0.375rem` (iets scherper dan de standaard van de componenten), in lijn met de rustige, documentachtige stijl van het merk.
- Er is nog **geen** volledig ontwerpsysteem met componenten overgenomen: alleen kleuren, lettertypen en logo. De componenten blijven de
  shadcn/ui-componenten van het dashboard, met deze tokens.
- Een eerdere versie van dit dashboard tekende een "D."-tegel naar het canvas in Claude Design; dat was **niet** het logo van het bedrijf. Het
  Logopakket De Installatiegroep is leidend: staaf en D, zonder letter of tegel, met het woordmerk in Inter.
