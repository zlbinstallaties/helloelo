import Anthropic from '@anthropic-ai/sdk'
import { executeTool, toolDefinitions, type ToolContext } from './tools.ts'

/*
 * The agent loop: stream a turn, run the requested tools, append the results,
 * repeat. History is append-only (thinking blocks stay valid), the system
 * prompt and tool list are stable (prompt caching), and every stop reason is
 * handled before any tool runs.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5'

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The part of the SDK client the loop uses; injectable for tests. */
export interface MessagesClient {
  beta: {
    messages: {
      stream(params: Anthropic.Beta.MessageCreateParams): {
        finalMessage(): Promise<Anthropic.Beta.BetaMessage>
      }
    }
  }
}

export interface AgentEvent {
  type: 'turn' | 'tool' | 'retry' | 'stop'
  turn: number
  detail: Record<string, unknown>
}

export interface RunOptions {
  client: MessagesClient
  tools: ToolContext
  system: string
  task: string
  model?: string
  effort?: Effort
  maxTurns?: number
  maxTokens?: number
  onEvent?: (event: AgentEvent) => void
}

export type RunStatus = 'done' | 'max_turns' | 'refusal' | 'max_tokens' | 'no_tool_progress'

export interface RunResult {
  status: RunStatus
  summary: string
  turns: number
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  messages: Anthropic.Beta.BetaMessageParam[]
}

const MAX_JSON_RETRIES = 2

function textOf(message: Anthropic.Beta.BetaMessage) {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export async function runAgent(options: RunOptions): Promise<RunResult> {
  const { client, tools: ctx, onEvent = () => {} } = options
  const model = options.model ?? DEFAULT_MODEL
  const maxTurns = options.maxTurns ?? 40
  const tools = toolDefinitions(ctx)
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: options.task }]
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let jsonRetries = 0
  let lastText = ''

  const finish = (status: RunStatus, turns: number, summary = lastText): RunResult => {
    onEvent({ type: 'stop', turn: turns, detail: { status } })
    return { status, summary, turns, usage, messages }
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: options.maxTokens ?? 64_000,
      // Thinking is adaptive by default on this model; effort is the control.
      output_config: { effort: options.effort ?? 'high' },
      // On a safety decline the API re-runs the request on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: options.system,
      tools,
      messages,
    })

    let message: Anthropic.Beta.BetaMessage
    try {
      message = await stream.finalMessage()
      jsonRetries = 0
    } catch (error) {
      // Only an unparseable streamed tool input is retried; API errors propagate.
      if (error instanceof Anthropic.APIError || jsonRetries++ >= MAX_JSON_RETRIES) throw error
      onEvent({ type: 'retry', turn, detail: { reason: 'tool input was not valid JSON' } })
      turn--
      continue
    }

    usage.input += message.usage.input_tokens
    usage.output += message.usage.output_tokens
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0
    const text = textOf(message)
    if (text) lastText = text
    onEvent({ type: 'turn', turn, detail: { stop: message.stop_reason, model: message.model, outputTokens: message.usage.output_tokens } })

    if (message.stop_reason === 'refusal') return finish('refusal', turn)
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content })
      continue
    }

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    // A tool input cut off at max_tokens can parse as a valid partial object.
    if (message.stop_reason === 'max_tokens') return finish('max_tokens', turn)
    if (toolUses.length === 0) {
      messages.push({ role: 'assistant', content: message.content })
      return finish(message.stop_reason === 'end_turn' ? 'done' : 'no_tool_progress', turn)
    }

    messages.push({ role: 'assistant', content: message.content })
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const use of toolUses) {
      const outcome = await executeTool(ctx, use.name, use.input)
      const input = use.input as Record<string, unknown> | null
      onEvent({
        type: 'tool',
        turn,
        detail: { name: use.name, path: typeof input?.path === 'string' ? input.path : undefined, ok: !outcome.isError },
      })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.content, is_error: outcome.isError })
    }
    // All results of one turn go back in a single user message.
    messages.push({ role: 'user', content: results })
  }
  return finish('max_turns', maxTurns)
}
