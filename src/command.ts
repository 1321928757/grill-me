import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** The slash command name this plugin owns, without the leading slash. */
export const GRILL_COMMAND = 'grill-me'

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

/**
 * Register the `/grill-me` host command. The handler never runs the design
 * tree itself: it steers the literal command line back into the agent as a
 * user message, and the model runs the forced grill loop through the
 * `grill_*` tools, guided by the "grill-me:usage" prompt section. The
 * command child activates only when a `commands` service is composed, so
 * assemblies without one still load the plugin (headless fallback is the
 * prompt protocol).
 */
export function registerGrillCommand(ctx: Context): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: GRILL_COMMAND,
      description: 'Force the grill-me workflow on a query',
      input: { hint: '[query]' },
      handler: (invocation: CommandInvocation): CommandResult => {
        if (typeof invocation.agent.steer !== 'function') {
          return { kind: 'error', text: `grill-me: no agent channel to accept the request. ${USAGE}` }
        }
        const query = invocation.rawInput.trim()
        invocation.agent.steer(createUserMessage({
          content: [{ type: 'text', text: grillLine(invocation.rawInput) }],
          source: { kind: 'user' },
        }))
        return {
          kind: 'success',
          text: query.length > 0
            ? `Grilling: ${query}`
            : 'Grilling your latest request.',
        }
      },
    })
  })
}
