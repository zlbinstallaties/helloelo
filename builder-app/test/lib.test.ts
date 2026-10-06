import test from 'node:test'
import assert from 'node:assert/strict'
import { availableActions, decisionInfo, eventLine, firstLine, followUpForm, formatCost, inlineTokens, parseDiff, parseMarkdown, publicationInfo, relativeTime, shortCommit, statusInfo } from '../public/lib.js'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
-old line
+new line
+extra line
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
\\ No newline at end of file
`

test('a unified diff is split into files with counts and typed lines', () => {
  const files = parseDiff(DIFF)
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed]), [['src/a.ts', 2, 1], ['new.txt', 1, 0]])
  assert.deepEqual(files[0].lines.map((l) => l.kind), ['hunk', 'ctx', 'del', 'add', 'add'])
  assert.ok(!files[0].lines.some((l) => l.text.startsWith('---') || l.text.startsWith('+++') || l.text.startsWith('index')))
  assert.equal(files[1].lines.at(-1)!.text, '\\ No newline at end of file')
  assert.deepEqual(parseDiff(''), [])
  assert.deepEqual(parseDiff('geen diff'), [])
})

test('content that looks like diff headers inside a file is still content', () => {
  const files = parseDiff('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n+--- not a header\n')
  assert.deepEqual([files[0].added, files[0].removed], [2, 1])
})

test('markdown is reduced to paragraphs, bullets, bold and code, and never to HTML', () => {
  const blocks = parseMarkdown('Eerste **vet** regel\nen verder.\n\n- punt `code`\n- nog een\n  - genest\n\nLaatste.')
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'ul', 'p'])
  assert.deepEqual(blocks[0].inline, [{ t: 'text', v: 'Eerste ' }, { t: 'strong', v: 'vet' }, { t: 'text', v: ' regel en verder.' }])
  assert.equal((blocks[1] as any).items.length, 3)
  assert.deepEqual(inlineTokens('<script>alert(1)</script>'), [{ t: 'text', v: '<script>alert(1)</script>' }])
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown(undefined), [])
})

test('progress lines are in Dutch and mark success and failure', () => {
  assert.deepEqual(eventLine({ type: 'tool', turn: 1, detail: { name: 'edit_file', path: 'src/a.ts', ok: true } }), { text: 'Past aan:', code: 'src/a.ts', mark: 'ok' })
  assert.deepEqual(eventLine({ type: 'tool', turn: 1, detail: { name: 'run_check', check: 'test', ok: false } }), { text: 'Draait check', code: 'test', mark: 'fail' })
  assert.equal(eventLine({ type: 'tool', turn: 1, detail: { name: 'probe_app', paths: ['/a', '/b'], ok: true } })!.code, '/a /b')
  assert.equal(eventLine({ type: 'tool', turn: 1, detail: { name: 'iets_nieuws', ok: true } })!.text, 'Gebruikt iets_nieuws')
  assert.equal(eventLine({ type: 'phase', turn: 0, detail: { phase: 'install' } })!.text, 'Dependencies installeren in de sandbox…')
  assert.equal(eventLine({ type: 'phase', turn: 0, detail: { phase: 'onbekend' } }), null)
  assert.equal(eventLine({ type: 'turn', turn: 1, detail: { stop: 'tool_use' } }), null)
  assert.deepEqual(eventLine({ type: 'stop', turn: 3, detail: { status: 'budget' } }), { text: 'Gestopt: kostenlimiet bereikt', mark: 'fail' })
  assert.equal(eventLine({ type: 'stop', turn: 3, detail: { status: 'done' } })!.mark, 'ok')
})

test('status and decision labels, and which buttons make sense', () => {
  assert.deepEqual(statusInfo({ state: 'running', status: null }), { label: 'Bezig', tone: 'info' })
  assert.deepEqual(statusInfo({ state: 'finished', status: 'done' }), { label: 'Klaar', tone: 'good' })
  assert.equal(statusInfo({ state: 'failed', status: 'error' }).tone, 'bad')
  assert.equal(statusInfo({ state: 'finished', status: 'iets_nieuws' }).label, 'iets_nieuws')
  assert.equal(decisionInfo({ decision: null }), null)
  assert.equal(decisionInfo({ decision: 'approved' })!.label, 'Goedgekeurd')

  const run = { state: 'finished', commit: 'abc', decision: null }
  assert.deepEqual(availableActions({ state: 'running' } as any), { stop: true, approve: false, reject: false, followUp: false })
  assert.deepEqual(availableActions(run as any), { stop: false, approve: true, reject: true, followUp: true })
  assert.deepEqual(availableActions({ ...run, commit: null } as any), { stop: false, approve: false, reject: true, followUp: false })
  assert.deepEqual(availableActions({ ...run, decision: 'approved' } as any), { stop: false, approve: false, reject: false, followUp: false })
  assert.deepEqual(availableActions({ state: 'failed', commit: null, decision: null } as any), { stop: false, approve: false, reject: true, followUp: false })
})

test('a run with a pending follow-up cannot be decided or followed up again; a superseded run is closed', () => {
  const waiting = { state: 'finished', commit: 'abc', decision: null, followUp: { id: 'x', task: 'y', state: 'finished' } }
  assert.deepEqual(availableActions(waiting as any), { stop: false, approve: false, reject: false, followUp: false })
  assert.deepEqual(availableActions({ state: 'finished', commit: 'abc', decision: 'superseded' } as any), { stop: false, approve: false, reject: false, followUp: false })
  assert.deepEqual(decisionInfo({ decision: 'superseded' } as any), { label: 'Opgenomen in vervolg', tone: '' })
})

test('the follow-up form continues unfinished work and adjusts finished work', () => {
  const adjust = followUpForm({ status: 'done' } as any)
  assert.equal(adjust.button, 'Pas aan')
  assert.equal(adjust.preset, '', 'the person writes what to change')
  for (const status of ['budget', 'max_turns', 'stopped']) {
    const carryOn = followUpForm({ status } as any)
    assert.equal(carryOn.button, 'Ga verder', status)
    assert.match(carryOn.preset, /Ga verder/, 'a sensible default the person can send as it is')
  }
})

test('cost, time and titles are formatted for people', () => {
  assert.match(formatCost(0.4927), /0,49/)
  assert.match(formatCost(5), /5,00/)
  assert.match(formatCost(undefined as any), /0,00/)
  const now = Date.parse('2026-10-05T12:00:00Z')
  assert.equal(relativeTime('2026-10-05T11:59:40Z', now), 'zojuist')
  assert.match(relativeTime('2026-10-05T11:55:00Z', now), /5 minuten geleden/)
  assert.match(relativeTime('2026-10-05T09:00:00Z', now), /3 uur geleden/)
  assert.match(relativeTime('2026-10-03T12:00:00Z', now), /eergisteren|2 dagen geleden/)
  assert.equal(firstLine('Eerste regel\ntweede'), 'Eerste regel')
  assert.equal(firstLine('x'.repeat(200), 10), 'xxxxxxxxx…')
})

const release = (id: string, live = false) => ({ id, commit: id.padEnd(40, '0'), createdAt: '2026-10-06T08:00:00.000Z', live })
const publication = (over: Record<string, unknown> = {}) => ({ enabled: true, url: null, current: null, releases: [], baseCommit: 'b'.repeat(40), upToDate: null, job: null, ...over })

test('publicationInfo: hidden without publishing, "not yet" before the first publish, up to date, outdated', () => {
  assert.deepEqual(publicationInfo(null), { kind: 'disabled' })
  assert.deepEqual(publicationInfo({ enabled: false }), { kind: 'disabled' })

  const first = publicationInfo(publication())
  assert.equal(first.kind, 'idle')
  assert.equal(first.headline?.label, 'Nog niet gepubliceerd')
  assert.equal(first.canPublish, true)
  assert.equal(first.canRestart, false)
  assert.equal(first.canRollback, false)

  const current = { releaseId: 'a1', commit: 'a'.repeat(40), publishedAt: '2026-10-06T08:00:00.000Z' }
  const fresh = publicationInfo(publication({ current, upToDate: true, releases: [release('a1', true)] }))
  assert.equal(fresh.headline?.tone, 'good')
  assert.equal(fresh.canPublish, false, 'nothing newer to publish')
  assert.equal(fresh.canRestart, true)
  assert.equal(fresh.canRollback, false, 'only the live version exists')

  const stale = publicationInfo(publication({ current, upToDate: false, releases: [release('a1', true), release('z9')] }))
  assert.equal(stale.headline?.tone, 'warn')
  assert.equal(stale.canPublish, true)
  assert.deepEqual(stale.rollbackTargets.map((r: { id: string }) => r.id), ['z9'])
  assert.equal(publicationInfo(publication({ baseCommit: null })).canPublish, false, 'no base branch, nothing to publish')
})

test('publicationInfo: while a job runs nothing can be started; a failed job shows its reason', () => {
  const running = publicationInfo(publication({ job: { kind: 'publish', state: 'running', phase: 'build' } }))
  assert.equal(running.kind, 'running')
  assert.match(running.detail, /gebouwd/)
  assert.deepEqual([running.canPublish, running.canRestart, running.canRollback], [false, false, false])
  assert.match(publicationInfo(publication({ job: { kind: 'rollback', state: 'running', phase: null } })).detail, /Bezig/)

  const failed = publicationInfo(publication({ job: { kind: 'publish', state: 'failed', error: 'De build mislukte.' } }))
  assert.equal(failed.kind, 'idle')
  assert.equal(failed.error, 'De build mislukte.')
  assert.equal(failed.canPublish, true, 'the person can try again')
  assert.equal(publicationInfo(publication({ job: { kind: 'publish', state: 'done' } })).error, null)
  assert.equal(shortCommit('0123456789abcdef'), '0123456')
})
