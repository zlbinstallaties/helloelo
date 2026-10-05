import test from 'node:test'
import assert from 'node:assert/strict'
import type Anthropic from '@anthropic-ai/sdk'
import { createCheckRunner } from '../src/checks.ts'
import { runAgent, type MessagesClient } from '../src/loop.ts'
import { Workspace } from '../src/workspace.ts'
import { tempProject } from './helpers.ts'

type Block = Anthropic.Beta.BetaContentBlock

function message(content: unknown[], stop: string): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: content as Block[],
    stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage
}

const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const text = (t: string) => ({ type: 'text', text: t })

/** Scripted client: returns the given turns in order and records each request. */
function scripted(turns: Array<Anthropic.Beta.BetaMessage | Error>) {
  const requests: Anthropic.Beta.MessageCreateParams[] = []
  const client: MessagesClient = {
    beta: {
      messages: {
        stream(params) {
          // Snapshot: the loop keeps appending to the same array.
          requests.push(structuredClone(params))
          const next = turns.shift()
          return {
            async finalMessage() {
              if (!next) throw new Error('script exhausted')
              if (next instanceof Error) throw next
              return next
            },
          }
        },
      },
    },
  }
  return { client, requests }
}

async function context(files: Record<string, string> = { 'src/app.ts': 'export const a = 1\n' }) {
  const ws = await Workspace.open(await tempProject(files))
  return { workspace: ws, checks: createCheckRunner(ws.root, { ok: ['/bin/true'] }) }
}

test('runs tools, feeds results back in one message, ends with the summary', async () => {
  const ctx = await context()
  const { client, requests } = scripted([
    message([text('Ik kijk eerst.'), use('t1', 'read_file', { path: 'src/app.ts' }), use('t2', 'list_files', {})], 'tool_use'),
    message([use('t3', 'edit_file', { path: 'src/app.ts', old_text: 'a = 1', new_text: 'a = 2' })], 'tool_use'),
    message([use('t4', 'run_check', { name: 'ok' })], 'tool_use'),
    message([text('Klaar: a is nu 2.')], 'end_turn'),
  ])
  const events: string[] = []
  const result = await runAgent({ client, tools: ctx, system: 'sys', task: 'zet a op 2', onEvent: (e) => events.push(e.type) })

  assert.equal(result.status, 'done')
  assert.equal(result.summary, 'Klaar: a is nu 2.')
  assert.equal(result.turns, 4)
  assert.equal(await ctx.workspace.readFile('src/app.ts'), 'export const a = 2\n')
  assert.deepEqual(result.usage, { input: 40, output: 20, cacheRead: 12, cacheWrite: 0 })

  const second = requests[1]
  const last = second.messages[second.messages.length - 1]
  assert.equal(last.role, 'user')
  const results = last.content as Anthropic.Beta.BetaToolResultBlockParam[]
  assert.deepEqual(results.map((r) => r.tool_use_id), ['t1', 't2'])
  assert.equal(results[0].content, 'export const a = 1\n')

  // Stable request shape: same system, tools, model, fallback and caching on every turn.
  for (const r of requests) {
    assert.equal(r.model, 'claude-opus-5-5')
    assert.equal(r.system, 'sys')
    assert.deepEqual(r.betas, ['server-side-fallback-2026-07-01'])
    assert.equal(r.fallbacks, 'default')
    assert.deepEqual(r.cache_control, { type: 'ephemeral' })
    assert.deepEqual(r.output_config, { effort: 'high' })
    assert.equal(r.thinking, undefined)
    assert.equal(r.tool_choice, undefined)
    assert.deepEqual(r.tools, requests[0].tools)
  }
  // Append-only history: each request extends the previous one.
  for (let i = 1; i < requests.length; i++) {
    assert.deepEqual(requests[i].messages.slice(0, requests[i - 1].messages.length), requests[i - 1].messages)
  }
  assert.ok(events.includes('tool') && events.at(-1) === 'stop')
})

test('bad tool input, unknown tools and escapes become error results, not crashes', async () => {
  const ctx = await context()
  const { client, requests } = scripted([
    message(
      [
        use('a', 'write_file', { path: 'x.ts' }),
        use('b', 'shell', { cmd: 'rm -rf /' }),
        use('c', 'read_file', { path: '../../etc/passwd' }),
        use('d', 'odoo_schema', {}),
        use('e', 'run_check', { name: 'deploy' }),
      ],
      'tool_use',
    ),
    message([text('Gestopt.')], 'end_turn'),
  ])
  await runAgent({ client, tools: ctx, system: 's', task: 't' })
  const results = requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[]
  assert.ok(results.every((r) => r.is_error === true))
  assert.match(String(results[0].content), /INVALID_INPUT/)
  assert.match(String(results[1].content), /unknown tool/)
  assert.match(String(results[2].content), /escapes/)
  assert.match(String(results[3].content), /unknown tool/)
  assert.match(String(results[4].content), /unknown check/)
  assert.ok(!requests[0].tools!.some((t) => 'name' in t && t.name === 'odoo_schema'))
})

test('tools are not run when the turn hit max_tokens or was refused', async () => {
  const ctx = await context()
  const truncated = scripted([message([use('a', 'write_file', { path: 'src/app.ts', contents: 'half' })], 'max_tokens')])
  assert.equal((await runAgent({ client: truncated.client, tools: ctx, system: 's', task: 't' })).status, 'max_tokens')
  assert.equal(await ctx.workspace.readFile('src/app.ts'), 'export const a = 1\n')

  const refused = scripted([message([use('a', 'write_file', { path: 'src/app.ts', contents: 'x' })], 'refusal')])
  assert.equal((await runAgent({ client: refused.client, tools: ctx, system: 's', task: 't' })).status, 'refusal')
  assert.equal(await ctx.workspace.readFile('src/app.ts'), 'export const a = 1\n')
})

test('max turns stops the run', async () => {
  const ctx = await context()
  const turns = Array.from({ length: 5 }, (_, i) => message([use(`t${i}`, 'list_files', {})], 'tool_use'))
  const { client } = scripted(turns)
  const result = await runAgent({ client, tools: ctx, system: 's', task: 't', maxTurns: 3 })
  assert.equal(result.status, 'max_turns')
  assert.equal(result.turns, 3)
})

test('pause_turn continues and an unparseable stream is retried a bounded number of times', async () => {
  const ctx = await context()
  const { client, requests } = scripted([
    new SyntaxError('Unexpected end of JSON input'),
    message([text('even pauze')], 'pause_turn'),
    message([text('Klaar.')], 'end_turn'),
  ])
  const result = await runAgent({ client, tools: ctx, system: 's', task: 't' })
  assert.equal(result.status, 'done')
  assert.equal(requests.length, 3)

  const broken = scripted([new SyntaxError('a'), new SyntaxError('b'), new SyntaxError('c')])
  await assert.rejects(runAgent({ client: broken.client, tools: ctx, system: 's', task: 't' }), SyntaxError)
})

test('odoo_schema is offered and used when a reader is configured', async () => {
  const ctx = { ...(await context()), odooSchema: async () => ({ models: [{ name: 'planning.slot' }] }) }
  const { client, requests } = scripted([message([use('s', 'odoo_schema', {})], 'tool_use'), message([text('ok')], 'end_turn')])
  await runAgent({ client, tools: ctx, system: 's', task: 't' })
  assert.ok(requests[0].tools!.some((t) => 'name' in t && t.name === 'odoo_schema'))
  const result = (requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]
  assert.match(String(result.content), /planning.slot/)
})
