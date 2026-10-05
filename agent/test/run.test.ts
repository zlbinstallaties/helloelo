import test from 'node:test'
import assert from 'node:assert/strict'
import type Anthropic from '@anthropic-ai/sdk'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { git } from '../src/git.ts'
import type { AgentEvent, MessagesClient } from '../src/loop.ts'
import { executeRun } from '../src/run.ts'
import { tempProject } from './helpers.ts'

function message(content: unknown[], stop: string): Anthropic.Beta.BetaMessage {
  return {
    id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage
}
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const text = (t: string) => ({ type: 'text', text: t })

function scripted(turns: Array<Anthropic.Beta.BetaMessage | (() => Anthropic.Beta.BetaMessage)>): MessagesClient {
  return {
    beta: {
      messages: {
        stream() {
          const next = turns.shift()
          return {
            async finalMessage() {
              if (!next) throw new Error('script exhausted')
              return typeof next === 'function' ? next() : next
            },
          }
        },
      },
    },
  }
}

async function repo() {
  const root = await tempProject({ 'src/app.ts': 'export const a = 1\n' })
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  const out = await mkdtemp(path.join(tmpdir(), 'dig-run-out-'))
  return { root, out }
}

test('a run commits on its branch, reports events and writes run.json and the diff', async () => {
  const { root, out } = await repo()
  const events: AgentEvent[] = []
  const outcome = await executeRun({
    workdir: root, task: 'Zet a op 2', outDir: out, runId: 'run-one',
    client: scripted([
      message([use('a', 'edit_file', { path: 'src/app.ts', old_text: 'a = 1', new_text: 'a = 2' })], 'tool_use'),
      message([text('Klaar.')], 'end_turn'),
    ]),
    onEvent: (e) => events.push(e),
  })
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.branch, 'builder/run-one')
  assert.equal(outcome.previous, 'main')
  assert.ok(outcome.commit)
  assert.deepEqual(outcome.changedFiles, ['src/app.ts'])
  assert.match(outcome.stat, /1 file changed/)
  const run = JSON.parse(await readFile(path.join(out, 'run-one', 'run.json'), 'utf8'))
  assert.deepEqual([run.status, run.task, run.previous, run.error], ['done', 'Zet a op 2', 'main', null])
  assert.match(await readFile(path.join(out, 'run-one', 'changes.diff'), 'utf8'), /\+export const a = 2/)
  assert.deepEqual(events.filter((e) => e.type === 'phase').map((e) => e.detail.phase), ['branch', 'agent', 'finish'])
  assert.ok(events.some((e) => e.type === 'tool' && e.detail.name === 'edit_file'))
  assert.equal((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'builder/run-one')
})

test('a run without changes removes its branch unless asked to keep it', async () => {
  const { root, out } = await repo()
  const outcome = await executeRun({ workdir: root, task: 'Niets', outDir: out, runId: 'noop', client: scripted([message([text('Niets te doen.')], 'end_turn')]) })
  assert.equal(outcome.commit, null)
  assert.equal((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
  assert.equal((await git(root, ['branch', '--list', 'builder/noop'])).trim(), '')

  const kept = await executeRun({ workdir: root, task: 'Niets', outDir: out, runId: 'kept', keepBranch: true, client: scripted([message([text('Niets.')], 'end_turn')]) })
  assert.equal(kept.commit, null)
  assert.match(await git(root, ['branch', '--list', 'builder/kept']), /builder\/kept/)
})

test('a failure after the branch exists is an outcome with status error, and the branch stays', async () => {
  const { root, out } = await repo()
  const client: MessagesClient = { beta: { messages: { stream() { throw new Error('netwerk weg') } } } }
  const outcome = await executeRun({ workdir: root, task: 'x', outDir: out, runId: 'boom', client })
  assert.equal(outcome.status, 'error')
  assert.match(outcome.error ?? '', /netwerk weg/)
  assert.match(await git(root, ['branch', '--list', 'builder/boom']), /builder\/boom/)
  assert.equal(JSON.parse(await readFile(path.join(out, 'boom', 'run.json'), 'utf8')).status, 'error')
})

test('setup problems are thrown before any branch is created', async () => {
  const { root, out } = await repo()
  const client = scripted([])
  await assert.rejects(executeRun({ workdir: root, task: '  ', outDir: out, client }), /task is empty/)
  await assert.rejects(executeRun({ workdir: root, task: 'x', outDir: path.join(root, 'out'), client }), /outside the working directory/)
  await assert.rejects(executeRun({ workdir: root, task: 'x', outDir: out, effort: 'extreme' as never, client }), /effort/)
  await assert.rejects(executeRun({ workdir: root, task: 'x', outDir: out, maxCostUsd: 0, client }), /maxCostUsd/)
  await git(root, ['checkout', '-q', '-b', 'dirty'])
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path.join(root, 'src/app.ts'), 'changed')
  await assert.rejects(executeRun({ workdir: root, task: 'x', outDir: out, client }), /not clean/)
  assert.equal((await git(root, ['branch', '--list', 'builder/*'])).trim(), '')
})

test('aborting stops the run cleanly and keeps the work done so far', async () => {
  const { root, out } = await repo()
  const controller = new AbortController()
  const outcome = await executeRun({
    workdir: root, task: 'Pas aan', outDir: out, runId: 'stopme', signal: controller.signal,
    client: scripted([
      () => {
        // The user presses stop while the first turn's tools are about to run.
        queueMicrotask(() => controller.abort())
        return message([use('a', 'write_file', { path: 'src/new.ts', contents: 'export {}\n' })], 'tool_use')
      },
      message([text('Dit zou niet meer mogen draaien.')], 'end_turn'),
    ]),
  })
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.turns, 1)
  assert.equal(outcome.error, null)
})
