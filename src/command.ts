import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** The slash command name this plugin owns, without the leading slash. */
export const GRILL_COMMAND = 'grill-me'

/** The docs-sinking sibling command: same grill loop, plus domain-modeling. */
export const GRILL_DOCS_COMMAND = 'grill-with-docs'

const USAGE = 'Usage: /grill-me [<query>]'

/**
 * Rebuild the exact command line the user typed. `rawInput` carries the
 * separator whitespace after the command name, so the steered message is the
 * literal line: replay logs reconstruct it verbatim, and the model applies
 * the same `/grill-me` protocol whether the line was steered by the command
 * handler or typed directly in a non-intercepted (headless) channel.
 */
export function grillLine(rawInput: string): string {
  return `/${GRILL_COMMAND}${rawInput}`
}

/** The literal `/grill-with-docs` line, for the docs-sinking sibling command. */
export function grillDocsLine(rawInput: string): string {
  return `/${GRILL_DOCS_COMMAND}${rawInput}`
}

interface GrillCommandSpec {
  name: string
  description: string
  line: (rawInput: string) => string
  usage: string
  success: (query: string) => string
}

/**
 * Register one `/grill-*` host command. The handler never runs the design
 * tree itself: it steers the literal command line back into the agent as a
 * user message, and the model runs the forced grill loop through the
 * `grill_*` tools, guided by the "grill-me:usage" prompt section. The
 * command child activates only when a `commands` service is composed, so
 * assemblies without one still load the plugin (headless fallback is the
 * prompt protocol).
 */
function registerGrillCommandSpec(ctx: Context, spec: GrillCommandSpec): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: spec.name,
      description: spec.description,
      input: { hint: '[query]' },
      handler: (invocation: CommandInvocation): CommandResult => {
        if (typeof invocation.agent.steer !== 'function') {
          return { kind: 'error', text: `${spec.name}: no agent channel to accept the request. ${spec.usage}` }
        }
        const query = invocation.rawInput.trim()
        invocation.agent.steer(createUserMessage({
          content: [{ type: 'text', text: spec.line(invocation.rawInput) }],
          source: { kind: 'user' },
        }))
        return {
          kind: 'success',
          text: spec.success(query),
        }
      },
    })
  })
}

/** Register the `/grill-me` pure-grilling command. */
export function registerGrillCommand(ctx: Context): void {
  registerGrillCommandSpec(ctx, {
    name: GRILL_COMMAND,
    description: 'Force the grill-me workflow on a query',
    line: grillLine,
    usage: USAGE,
    success: query => query.length > 0 ? `Grilling: ${query}` : 'Grilling your latest request.',
  })
}

/** Register the `/grill-with-docs` command: same loop, plus domain-modeling. */
export function registerGrillDocsCommand(ctx: Context): void {
  registerGrillCommandSpec(ctx, {
    name: GRILL_DOCS_COMMAND,
    description: 'Force the grill-me workflow on a query while writing CONTEXT.md glossary and ADRs',
    line: grillDocsLine,
    usage: 'Usage: /grill-with-docs [<query>]',
    success: query => query.length > 0 ? `Grilling with docs: ${query}` : 'Grilling your latest request with docs.',
  })
}
