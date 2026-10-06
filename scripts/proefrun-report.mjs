// Combines the runs of one proefrun session into a single markdown report.
//   node scripts/proefrun-report.mjs <runs dir> <session.tsv>
// The session file has one "label<TAB>run id" line per run. Prints the report on stdout.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const [runsDir, sessionFile] = process.argv.slice(2)
if (!runsDir || !sessionFile) {
  console.error('usage: node scripts/proefrun-report.mjs <runs dir> <session.tsv>')
  process.exit(2)
}

const MAX_DIFF_CHARS = 60_000
const rows = readFileSync(sessionFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t'))

function toolSummary(events) {
  const tools = events.filter((event) => event.type === 'tool')
  const checks = tools.filter((event) => event.detail.name === 'run_check').map((event) => `${event.detail.check} ${event.detail.ok ? 'ok' : 'FOUT'}`)
  const probes = tools.filter((event) => event.detail.name === 'probe_app').map((event) => `${(event.detail.paths ?? []).join(' ')} ${event.detail.ok ? 'ok' : 'FOUT'}`)
  const count = (name) => tools.filter((event) => event.detail.name === name).length
  return {
    checks,
    probes,
    reads: count('read_file'),
    edits: count('edit_file') + count('write_file'),
    schema: count('odoo_schema'),
    failedTools: tools.filter((event) => event.detail.ok === false).length,
  }
}

let totalCost = 0
const sections = []
rows.forEach(([label, runId], index) => {
  const dir = path.join(runsDir, runId)
  if (!existsSync(path.join(dir, 'run.json'))) {
    sections.push(`## ${index + 1}. ${label}\n\nGeen run.json gevonden voor ${runId} (de run is waarschijnlijk afgebroken).\n`)
    return
  }
  const run = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8'))
  const diff = existsSync(path.join(dir, 'changes.diff')) ? readFileSync(path.join(dir, 'changes.diff'), 'utf8') : ''
  const tools = toolSummary(run.events ?? [])
  totalCost += run.estimatedCostUsd ?? 0
  sections.push(
    [
      `## ${index + 1}. ${label}: ${run.status}, ${run.turns} beurten, ca. $${(run.estimatedCostUsd ?? 0).toFixed(2)}`,
      '',
      `Opdracht: ${run.task ?? '(niet vastgelegd)'}`,
      '',
      `- Modus: ${run.sandbox ? 'sandbox' : 'op deze computer'}, model ${run.model}, effort ${run.effort}`,
      `- Gewijzigde bestanden: ${(run.changedFiles ?? []).join(', ') || '(geen)'}`,
      `- Gelezen bestanden: ${tools.reads}, bewerkingen: ${tools.edits}, odoo_schema: ${tools.schema}, mislukte toolaanroepen: ${tools.failedTools}`,
      `- Checks: ${tools.checks.join(', ') || '(geen)'}`,
      `- Probe: ${tools.probes.join(' | ') || '(niet gebruikt)'}`,
      `- Tokens: invoer ${run.usage?.input}, uitvoer ${run.usage?.output}, cache gelezen ${run.usage?.cacheRead}`,
      '',
      '### Samenvatting van de agent',
      '',
      run.summary ?? '',
      '',
      '### Diff',
      '',
      '```diff',
      diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[... ${diff.length - MAX_DIFF_CHARS} tekens ingekort]` : diff.trimEnd() || '(geen wijzigingen)',
      '```',
      '',
    ].join('\n'),
  )
})

console.log(`# Proefrun-rapport ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n`)
console.log(`${rows.length} run(s), geschatte kosten samen ca. $${totalCost.toFixed(2)}. Geen sleutels of klantgegevens in dit rapport.\n`)
console.log(sections.join('\n'))
