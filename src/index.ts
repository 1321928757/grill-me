import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.tools and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerGrillTools, type GrillToolsConfig } from './tools.ts'

export const name = 'grill-me'
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration. */
export interface Config {
  /** State directory name under the caller workspace; sessions live at `<workspace>/<stateDir>/<sessionId>/`. */
  stateDir?: string
  /** Hard cap on design-tree rounds before the agent must summarize and ask the user how to proceed. */
  maxRounds?: number
  /** Prompt-section order for the grill-me usage policy. */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.grill-me'),
  maxRounds: z.natural().default(8),
  promptSectionOrder: z.natural().default(118),
})

function usageSectionText(): string {
  return `When the user's query is vague, has unstated scope, or mixes multiple possible goals, grill the user before acting:
1. Build a design tree: every decision is a node; settled answers unlock the decisions that depend on them.
2. Ask the whole frontier in one round: number every question and give your recommended answer. Never ask questions whose prerequisites are still open.
3. Finding facts is your job. Look up anything you can from the environment; only decisions belong to the user.
4. After each round, record answers with grill_answer, then recompute the frontier and ask the next round.
5. When the frontier is empty and the user confirms, call grill_settle with an explicit boundary spec. Do not execute the query before the boundary is settled.
6. Use grill_archive to close the session after the query is executed or abandoned.`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: GrillToolsConfig = {
    stateDir: config.stateDir ?? '.grill-me',
    maxRounds: config.maxRounds ?? 8,
  }
  ctx.systemPrompt.section({
    name: 'grill-me:usage',
    order: config.promptSectionOrder ?? 118,
    text: usageSectionText(),
  })
  registerGrillTools(ctx, resolved)
}