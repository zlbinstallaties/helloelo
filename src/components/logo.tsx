/*
 * The logo of De Installatiegroep, as drawn in Claude Design ("Logo De Installatiegroep"): the wordmark "De Installatiegroep."
 * in Fraunces with the copper full stop, and the "D." tile. The tile is drawn from the outlines of the letters (Fraunces, weight
 * 600), so it needs no font and looks the same everywhere. Colours are tokens (src/styles.css); the tile keeps its own navy and
 * paper in light and dark, with a hairline edge so that it is still seen on the dark navy of the header.
 */

export function LogoMark({ className = 'size-11' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="De Installatiegroep">
      <rect x="0.5" y="0.5" width="63" height="63" rx="11.5" className="fill-brand-navy stroke-border" />
      <g transform="translate(14.44 45.6) scale(0.01968 -0.01968)">
        <path className="fill-brand-paper" d="M68 6Q68 13 79 14L165 27Q184 30 192 37Q200 43 200 55V1342Q200 1356 192 1363Q184 1370 166 1373L77 1387Q68 1388 68 1394Q68 1397 71 1399Q73 1400 77 1400H561Q742 1400 891 1348Q1041 1295 1149 1195Q1258 1094 1317 950Q1376 806 1376 624Q1376 427 1286 287Q1197 148 1037 74Q877 0 664 0H77Q73 0 71 2Q68 4 68 6ZM664 18Q784 18 879 85Q973 151 1027 291Q1082 432 1082 655Q1082 831 1046 966Q1011 1102 943 1194Q875 1287 779 1334Q683 1382 562 1382H480V55Q480 38 490 28Q500 18 518 18Z" />
        <path className="fill-seam" transform="translate(1373 0)" d="M199 -18Q159 -18 127 3Q95 23 77 57Q58 91 58 132Q58 172 77 206Q96 240 128 260Q160 280 200 280Q240 280 273 260Q305 240 324 206Q343 173 343 133Q343 91 324 57Q305 23 273 3Q241 -18 199 -18Z" />
      </g>
    </svg>
  )
}

/** The wordmark: "De Installatiegroep" with the copper full stop. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-semibold tracking-tight ${className}`}>
      De Installatiegroep<span className="text-seam">.</span>
    </span>
  )
}
