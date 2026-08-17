import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.tools and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerGrillCommand } from './command.ts'
import { registerGrillTools, type GrillToolsConfig } from './tools.ts'

export const name = 'grill-me'
export const inject = ['tools', 'systemPrompt', 'userQuestions']

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
3. Ask the whole frontier in one round through grill_ask: call grill_ask with the session_id; it renders every frontier decision as a DSH question card (the recommended answer is the first option, marked 推荐, plus a custom-answer field), and records the answers into the design tree automatically. The card is the ONLY allowed presentation — never ask grill questions as plain text.
4. Finding facts is your job. Look up anything you can from the environment; only decisions belong to the user.
5. After each round, recompute the frontier from the grill_ask result and ask the next round the same way. Do not ask questions whose prerequisites are still open.
6. Do not execute the query before the boundary is settled: when the frontier is empty, write the explicit boundary spec and call grill_ask again with the boundary — it presents a settle-confirmation card; only after the user approves it is the boundary frozen, and only then may you execute.
7. Use grill_archive to close the session after the query is executed or abandoned. In environments without a question-card UI (headless CLI), grill_ask fails with a user-questions-unavailable error — then ask in plain text and record answers with grill_answer instead.`
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