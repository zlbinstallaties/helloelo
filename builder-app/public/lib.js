// Pure helpers of the builder UI: no DOM, so they can be tested in Node.

const STATUS = {
  done: { label: 'Klaar', tone: 'good' },
  budget: { label: 'Kostenlimiet bereikt', tone: 'warn' },
  max_turns: { label: 'Maximaal aantal stappen bereikt', tone: 'warn' },
  stopped: { label: 'Gestopt', tone: 'warn' },
  refusal: { label: 'Geweigerd door het model', tone: 'bad' },
  max_tokens: { label: 'Antwoord afgebroken', tone: 'bad' },
  no_tool_progress: { label: 'Vastgelopen', tone: 'bad' },
  error: { label: 'Fout', tone: 'bad' },
}

/** Label and tone for the state of a run. */
export function statusInfo(run) {
  if (run.state === 'running') return { label: 'Bezig', tone: 'info' }
  return STATUS[run.status] ?? { label: run.status ?? 'Onbekend', tone: 'warn' }
}

export function decisionInfo(run) {
  if (run.decision === 'approved') return { label: 'Goedgekeurd', tone: 'good' }
  if (run.decision === 'rejected') return { label: 'Afgewezen', tone: 'bad' }
  return null
}

/** What the person can do with a run right now. */
export function availableActions(run) {
  if (run.state === 'running') return { stop: true, approve: false, reject: false }
  const undecided = !run.decision
  return { stop: false, approve: undecided && run.state === 'finished' && Boolean(run.commit), reject: undecided }
}

const TOOL_TEXT = {
  list_files: () => ({ text: 'Bekijkt de bestanden' }),
  read_file: (d) => ({ text: 'Leest', code: d.path }),
  write_file: (d) => ({ text: 'Schrijft', code: d.path }),
  edit_file: (d) => ({ text: 'Past aan:', code: d.path }),
  run_check: (d) => ({ text: 'Draait check', code: d.check }),
  probe_app: (d) => ({ text: 'Kijkt naar de draaiende app:', code: (d.paths ?? []).join(' ') }),
  odoo_schema: () => ({ text: 'Leest welke Odoo-velden beschikbaar zijn' }),
}

/** One line of the progress list, or null for events that are not worth showing. */
export function eventLine(event) {
  if (event.type === 'phase') {
    const phases = {
      branch: 'Eigen branch aangemaakt',
      install: 'Dependencies installeren in de sandbox…',
      agent: 'De agent gaat aan het werk',
      finish: 'Wijzigingen vastleggen',
    }
    const text = phases[event.detail.phase]
    return text ? { text, mark: 'run' } : null
  }
  if (event.type === 'tool') {
    const make = TOOL_TEXT[event.detail.name]
    const line = make ? make(event.detail) : { text: `Gebruikt ${event.detail.name}` }
    return { ...line, mark: event.detail.ok ? 'ok' : 'fail' }
  }
  if (event.type === 'retry') return { text: 'Opnieuw proberen (ongeldige invoer van het model)', mark: 'fail' }
  if (event.type === 'stop') {
    const info = STATUS[event.detail.status]
    return { text: `Gestopt: ${info ? info.label.toLowerCase() : event.detail.status}`, mark: event.detail.status === 'done' ? 'ok' : 'fail' }
  }
  return null
}

/** Splits a unified diff into files with their lines. */
export function parseDiff(text) {
  /** @type {{ path: string, added: number, removed: number, lines: { kind: string, text: string }[] }[]} */
  const files = []
  /** @type {(typeof files)[number] | null} */
  let current = null
  for (const raw of String(text).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      current = { path: match ? match[2] : raw.slice(11), added: 0, removed: 0, lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (/^(index |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) )/.test(raw) || raw.startsWith('--- ') || raw.startsWith('+++ ')) continue
    if (raw.startsWith('@@')) current.lines.push({ kind: 'hunk', text: raw })
    else if (raw.startsWith('+')) { current.added++; current.lines.push({ kind: 'add', text: raw }) }
    else if (raw.startsWith('-')) { current.removed++; current.lines.push({ kind: 'del', text: raw }) }
    else if (raw.startsWith('\\')) current.lines.push({ kind: 'ctx', text: raw })
    else current.lines.push({ kind: 'ctx', text: raw })
  }
  for (const file of files) {
    while (file.lines.length && file.lines[file.lines.length - 1].text === '') file.lines.pop()
  }
  return files
}

/** Inline tokens: **bold**, `code` and plain text. Never produces HTML. */
export function inlineTokens(text) {
  const tokens = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) tokens.push({ t: 'text', v: text.slice(last, match.index) })
    const value = match[0]
    tokens.push(value.startsWith('**') ? { t: 'strong', v: value.slice(2, -2) } : { t: 'code', v: value.slice(1, -1) })
    last = match.index + value.length
  }
  if (last < text.length) tokens.push({ t: 'text', v: text.slice(last) })
  return tokens
}

/** A small subset of markdown: paragraphs and bullet lists (nested bullets are flattened). */
export function parseMarkdown(text) {
  /** @type {any[]} */
  const blocks = []
  /** @type {any} */
  let list = null
  /** @type {string[]} */
  let paragraph = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', inline: inlineTokens(paragraph.join(' ')) })
    paragraph = []
  }
  for (const line of String(text ?? '').split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      if (!list) {
        list = { type: 'ul', items: [] }
        blocks.push(list)
      }
      list.items.push(inlineTokens(bullet[1]))
    } else if (line.trim() === '') {
      flush()
      list = null
    } else {
      list = null
      paragraph.push(line.trim())
    }
  }
  flush()
  return blocks
}

export function formatCost(value) {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value ?? 0)
}

export function relativeTime(iso, now = Date.now()) {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat('nl', { numeric: 'auto' })
  if (abs < 45) return 'zojuist'
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour')
  return formatter.format(Math.round(seconds / 86400), 'day')
}

export function firstLine(text, max = 90) {
  const line = String(text ?? '').trim().split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const PUBLISH_PHASES = {
  export: 'De versie wordt klaargezet…',
  install: 'Dependencies worden geïnstalleerd…',
  build: 'De app wordt gebouwd…',
  start: 'De nieuwe versie wordt gestart…',
  check: 'Er wordt gecontroleerd of de nieuwe versie antwoordt…',
  switch: 'Er wordt overgeschakeld naar de nieuwe versie…',
}

const JOB_TITLE = { publish: 'Publiceren', rollback: 'Terugdraaien', restart: 'Opnieuw starten' }

export function shortCommit(commit) {
  return String(commit ?? '').slice(0, 7)
}

/**
 * What the publication card shows and allows. `kind` is "disabled" (hide the card), "running" or "idle".
 * Publishing is offered only when the live version is not already the tip of the base branch.
 */
export function publicationInfo(status) {
  if (!status || !status.enabled) return { kind: 'disabled' }
  const job = status.job
  if (job?.state === 'running') {
    return {
      kind: 'running',
      title: JOB_TITLE[job.kind] ?? 'Bezig',
      detail: PUBLISH_PHASES[job.phase] ?? 'Bezig…',
      canPublish: false,
      canRestart: false,
      canRollback: false,
      rollbackTargets: [],
      error: null,
    }
  }
  let headline
  if (!status.current) headline = { label: 'Nog niet gepubliceerd', tone: 'warn' }
  else if (status.upToDate) headline = { label: 'Live en bijgewerkt', tone: 'good' }
  else headline = { label: 'Live, maar er zijn nieuwere wijzigingen', tone: 'warn' }
  return {
    kind: 'idle',
    headline,
    canPublish: status.upToDate !== true && Boolean(status.baseCommit),
    canRestart: Boolean(status.current),
    canRollback: status.releases.some((r) => !r.live),
    rollbackTargets: status.releases.filter((r) => !r.live),
    error: job?.state === 'failed' ? job.error : null,
  }
}
