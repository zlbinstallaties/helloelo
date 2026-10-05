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
  /** Stop before the next request once the estimated cost reaches this amount. */
  maxCostUsd?: number
  onEvent?: (event: AgentEvent) => void
}

export type RunStatus = 'done' | 'max_turns' | 'refusal' | 'max_tokens' | 'no_tool_progress' | 'budget'

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface RunResult {
  status: RunStatus
  summary: string
  turns: number
  usage: Usage
  /** Estimated from token counts and list prices; the invoice is authoritative. */
  estimatedCostUsd: number
  messages: Anthropic.Beta.BetaMessageParam[]
}

/** USD per million tokens: uncached input, output, cache read, cache write (5 min). */
const PRICES: Record<string, readonly [number, number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-fable-5-1': [10, 50, 0.25, 12.5],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
}

export function estimateCostUsd(model: string, usage: Usage): number {
  // Unknown models are priced like the default model, so the limit stays conservative-ish.
  const [input, output, read, write] = PRICES[model] ?? PRICES[DEFAULT_MODEL]
  return (usage.input * input + usage.output * output + usage.cacheRead * read + usage.cacheWrite * write) / 1_000_000
}

/**
 * After a mid-output fallback, thinking and tool_use blocks that come before the
 * last `fallback` block belong to the declined attempt: they are not echoed back
 * and their tools are not run. Everything after the boundary is normal.
 */
export function afterFallback<T extends { type: string }>(content: T[]): T[] {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback')
  if (boundary === -1) return content
  const dropped = new Set(['thinking', 'redacted_thinking', 'tool_use'])
  return content.filter((block, index) => index >= boundary || !dropped.has(block.type))
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
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const maxCostUsd = options.maxCostUsd ?? Infinity
  let jsonRetries = 0
  let lastText = ''

  const finish = (status: RunStatus, turns: number, summary = lastText): RunResult => {
    onEvent({ type: 'stop', turn: turns, detail: { status } })
    return { status, summary, turns, usage, estimatedCostUsd: estimateCostUsd(model, usage), messages }
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (estimateCostUsd(model, usage) >= maxCostUsd) return finish('budget', turn - 1)
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
    const echoed = afterFallback(message.content) as Anthropic.Beta.BetaContentBlockParam[]
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: echoed })
      continue
    }

    const toolUses = afterFallback(message.content).filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    // A tool input cut off at max_tokens can parse as a valid partial object.
    if (message.stop_reason === 'max_tokens') return finish('max_tokens', turn)
    if (toolUses.length === 0) {
      messages.push({ role: 'assistant', content: echoed })
      return finish(message.stop_reason === 'end_turn' ? 'done' : 'no_tool_progress', turn)
    }

    messages.push({ role: 'assistant', content: echoed })
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const use of toolUses) {
      const outcome = await executeTool(ctx, use.name, use.input)
      const input = use.input as Record<string, unknown> | null
      onEvent({
        type: 'tool',
        turn,
        detail: {
          name: use.name,
          path: typeof input?.path === 'string' ? input.path : undefined,
          check: use.name === 'run_check' && typeof input?.name === 'string' ? input.name : undefined,
          paths: use.name === 'probe_app' && Array.isArray(input?.paths) ? input.paths : undefined,
          ok: !outcome.isError,
        },
      })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.content, is_error: outcome.isError })
    }
    // All results of one turn go back in a single user message.
    messages.push({ role: 'user', content: results })
  }
  return finish('max_turns', maxTurns)
}
