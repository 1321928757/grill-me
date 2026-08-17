import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.tools and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerGrillCommand } from './command.ts'
import { registerGrillTools, type GrillToolsConfig } from './tools.ts'

export const name = 'grill-me'
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration. */
export interface Config {
  /** State directory name under the caller workspace; sessions live at `<workspace>/<stateDir>/<sessionId>/`. */
  stateDir?: string

  /** Prompt-section order for the grill-me usage policy. */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.grill-me'),
  promptSectionOrder: z.natural().default(118),
})

function usageSectionText(): string {
  return `Grilling is invoked only by the /grill-me command — there is no automatic trigger for vague queries.
When the user's message begins with /grill-me (typed directly, or steered from the command by the client), the grill workflow is FORCED and may not be skipped because the query looks crisp:
1. "/grill-me <query>" grills that query. A bare "/grill-me" grills the user's most recent substantive request in this conversation; if there is none, say so and show the usage.
2. Build a design tree: every decision is a node; settled answers unlock the decisions that depend on them.
3. Ask the whole frontier in one round: number every question and give your recommended answer. Never ask questions whose prerequisites are still open.
4. Finding facts is your job. Look up anything you can from the environment; only decisions belong to the user.
5. After each round, record answers with grill_answer, then recompute the frontier and ask the next round.
6. Do not execute the query before the boundary is settled: when the frontier is empty and the user confirms, call grill_settle with an explicit boundary spec.
7. Use grill_archive to close the session after the query is executed or abandoned.`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: GrillToolsConfig = {
    stateDir: config.stateDir ?? '.grill-me',
  }
  ctx.systemPrompt.section({
    name: 'grill-me:usage',
    order: config.promptSectionOrder ?? 118,
    text: usageSectionText(),
  })
  registerGrillTools(ctx, resolved)
  registerGrillCommand(ctx)
}