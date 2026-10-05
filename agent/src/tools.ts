import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { CheckRunner } from './checks.ts'
import { MAX_PROBE_PATHS, validateProbePath, type Probe } from './probe.ts'
import type { Workspace } from './workspace.ts'

/*
 * Tool definitions for the agent plus their executors. Inputs arrive with
 * eager input streaming, so the API does not validate them: every input is
 * parsed with the zod schema below before anything runs.
 */

export interface ToolContext {
  workspace: Workspace
  checks: CheckRunner
  /** Fetches the gateway schema; absent when no gateway is configured. */
  odooSchema?: () => Promise<unknown>
  /** Builds and starts the app on fake data and requests paths; absent when the project has no probe. */
  probe?: Probe
}

export interface ToolOutcome {
  content: string
  isError: boolean
}

const schemas = {
  list_files: z.object({ dir: z.string().optional() }).strict(),
  read_file: z.object({ path: z.string() }).strict(),
  write_file: z.object({ path: z.string(), contents: z.string() }).strict(),
  edit_file: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }).strict(),
  run_check: z.object({ name: z.string() }).strict(),
  odoo_schema: z.object({}).strict(),
  probe_app: z.object({ paths: z.array(z.string()).min(1).max(MAX_PROBE_PATHS) }).strict(),
}

export type ToolName = keyof typeof schemas

export function toolDefinitions(ctx: ToolContext): Anthropic.Beta.BetaTool[] {
  const tools: Anthropic.Beta.BetaTool[] = [
    {
      name: 'list_files',
      description:
        'List project files (recursive, sorted). Git internals, node_modules, build output and secret files are hidden.',
      input_schema: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Directory relative to the project root; default is the root.' } },
        additionalProperties: false,
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the project.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the project root.' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file with the full new contents. Prefer edit_file for changes to existing files.',
      eager_input_streaming: true,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root.' },
          contents: { type: 'string', description: 'Complete file contents.' },
        },
        required: ['path', 'contents'],
        additionalProperties: false,
      },
    },
    {
      name: 'edit_file',
      description:
        'Replace one exact occurrence of old_text with new_text in an existing file. old_text must match exactly once; include enough surrounding lines.',
      eager_input_streaming: true,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
    {
      name: 'run_check',
      description: 'Run a named project check and return its output. Run checks after changing code and fix what they report.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', enum: ctx.checks.names } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ]
  if (ctx.probe) {
    tools.push({
      name: 'probe_app',
      description:
        'Look at the running app: builds it, starts it against realistic fake data (including awkward cases such as ' +
        'several visits on one appointment, records that point at something not loaded, empty values and different ' +
        'statuses) and returns status and body of GET requests to the given paths of the app, for example ' +
        '/api/dashboard?scope=all. Use it after your checks to verify what your change really returns, and look at the ' +
        'edge cases in the data. It does not render the UI, so never claim that you saw the screen.',
      input_schema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_PROBE_PATHS,
            description: 'Paths of the app, each starting with /, e.g. /api/health or /api/dashboard?scope=all.',
          },
        },
        required: ['paths'],
        additionalProperties: false,
      },
    })
  }
  if (ctx.odooSchema) {
    tools.push({
      name: 'odoo_schema',
      description:
        'Read the Odoo models, fields, types and relations this app may use through the gateway. Read-only; contains no records.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    })
  }
  return tools
}

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name)
}

export async function executeTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (!isToolName(name) || (name === 'odoo_schema' && !ctx.odooSchema) || (name === 'probe_app' && !ctx.probe)) {
    return { content: `unknown tool: ${name}`, isError: true }
  }
  const parsed = schemas[name].safeParse(rawInput)
  if (!parsed.success) {
    // Covers inputs the tolerant stream parser cut short.
    return { content: `INVALID_INPUT: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, isError: true }
  }
  const input = parsed.data as Record<string, string>
  try {
    switch (name) {
      case 'list_files': {
        const files = await ctx.workspace.listFiles(input.dir)
        return { content: files.length ? files.join('\n') : '(geen bestanden)', isError: false }
      }
      case 'read_file':
        return { content: await ctx.workspace.readFile(input.path), isError: false }
      case 'write_file':
        await ctx.workspace.writeFile(input.path, input.contents)
        return { content: `written: ${input.path}`, isError: false }
      case 'edit_file':
        await ctx.workspace.editFile(input.path, input.old_text, input.new_text)
        return { content: `edited: ${input.path}`, isError: false }
      case 'run_check': {
        const result = await ctx.checks.run(input.name)
        const status = result.timedOut ? 'TIMED OUT' : result.ok ? 'PASSED' : `FAILED (exit ${result.exitCode})`
        return { content: `${result.name}: ${status}\n${result.output}`, isError: !result.ok }
      }
      case 'probe_app': {
        const paths = (parsed.data as { paths: string[] }).paths
        const invalid = paths.map(validateProbePath).find((message) => message !== null)
        if (invalid) return { content: invalid, isError: true }
        const result = await ctx.probe!(paths)
        return { content: result.ok ? result.output : `probe failed:\n${result.output}`, isError: !result.ok }
      }
      case 'odoo_schema':
        return { content: JSON.stringify(await ctx.odooSchema!(), null, 2), isError: false }
    }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}
