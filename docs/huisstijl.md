# Huisstijl van het dashboard

Het dashboard gebruikt de kleuren, de lettertypen en het logo van **De Installatiegroep**, zoals die in Claude Design staan: het canvas
*Logo De Installatiegroep* (woordmerk licht en donker, icoon "D.") en de tokens van het ontwerpsysteem (licht en donker, uit de audit
*De Installatiegroep Design System*). Alles staat op één plek: `src/styles.css`. Pas je daar een token aan, dan verandert het overal.

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

Het logo-icoon houdt in licht en donker zijn eigen navy en papier (`--brand-navy`, `--brand-paper`). De rand is `--border`: een dun
lijntje, zodat het icoon ook op de donkere kop zichtbaar is. Gebruik in componenten altijd de tokens (`bg-background`, `text-seam`, ...) en
nooit een hex.

## Lettertypen

**Fraunces** voor koppen en het woordmerk (met de optische-grootte-as), **Inter** voor tekst. Ze komen **mee met de app**
(`@fontsource-variable/fraunces` en `@fontsource-variable/inter`, geladen in `src/styles.css`); er gaat geen verzoek naar een
lettertypedienst, en dat is bewust zo: de pagina werkt ook achter een firewall en laat geen gegevens naar derden lekken.

## Logo

`src/components/logo.tsx`:

- `LogoMark`: het icoon "D." als inline SVG. De letters zijn de contouren van Fraunces (gewicht 600, optische grootte 144), dus het
  icoon heeft geen lettertype nodig en ziet er overal hetzelfde uit.
- `Wordmark`: "De Installatiegroep" met de koperen punt, in Fraunces.
- `public/favicon.svg`: hetzelfde icoon voor het tabblad.

Het logo staat in de kop van elke pagina en boven het inlogscherm.

## Wat bewust anders is dan in Claude Design

- De hoekradius is `0.375rem` (iets scherper dan de standaard van de componenten), in lijn met de rustige, documentachtige stijl van het merk.
- Er is nog **geen** volledig ontwerpsysteem met componenten overgenomen: alleen kleuren, lettertypen en logo. De componenten blijven de
  shadcn/ui-componenten van het dashboard, met deze tokens.
- De audit noemt dat het merk-logo in de code en in de SVG-bestanden net verschilt (de koperen lijn in de inverse versie). Hier is het icoon
  getekend vanuit het canvas *Logo De Installatiegroep* (koper `#B87333`, in donker `#CA8E56`).
