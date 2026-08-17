import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.tools and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerGrillCommand, registerGrillDocsCommand } from './command.ts'
import { registerGrillDocsTools, type DocsToolsConfig } from './docs.ts'
import { registerGrillTools, type GrillToolsConfig } from './tools.ts'

export const name = 'grill-me'
export const inject = ['tools', 'systemPrompt', 'userQuestions']

/** Plugin configuration. */
export interface Config {
  /** State directory name under the caller workspace; sessions live at `<workspace>/<stateDir>/<sessionId>/`. */
  stateDir?: string

  /** Prompt-section order for the grill-me usage policy. */
  promptSectionOrder?: number

  /** Whether /grill-with-docs sessions may sink CONTEXT.md / ADR docs. */
  docsEnabled?: boolean

  /** Docs root relative to the caller workspace; '' means the workspace root. */
  docsDir?: string
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.grill-me'),
  promptSectionOrder: z.natural().default(118),
  docsEnabled: z.boolean().default(true),
  docsDir: z.string().default(''),
})

function usageSectionText(): string {
  return `Grilling is invoked only by the /grill-me command — there is no automatic trigger for vague queries.
When the user's message begins with /grill-me (typed directly, or steered from the command by the client), the grill workflow is FORCED and may not be skipped because the query looks crisp:
1. "/grill-me <query>" grills that query. A bare "/grill-me" grills the user's most recent substantive request in this conversation; if there is none, say so and show the usage.
2. Build a design tree: every decision is a node; settled answers unlock the decisions that depend on them.
3. Ask the whole frontier in one round through grill_ask: call grill_ask with the session_id; it renders every frontier decision as a DSH question card (2-4 options, the recommended answer first and marked 推荐, plus a custom-answer field), and records the answers into the design tree automatically. The card is the ONLY allowed presentation — never ask grill questions as plain text.
4. Finding facts is your job. Look up anything you can from the environment; only decisions belong to the user.
5. After each round, recompute the frontier from the grill_ask result and ask the next round the same way. Do not ask questions whose prerequisites are still open.
6. Do not execute the query before the boundary is settled: when the frontier is empty, write the explicit boundary spec and call grill_ask again with the boundary — it presents a settle-confirmation card; only after the user approves it is the boundary frozen, and only then may you execute.
7. Use grill_archive to close the session after the query is executed or abandoned. In environments without a question-card UI (headless CLI), grill_ask fails with a user-questions-unavailable error — then ask in plain text and record answers with grill_answer instead.`
}

function docsUsageSectionText(): string {
  return `The /grill-with-docs command runs the same forced grill loop as /grill-me (design tree, frontier rounds, settle confirmation) and additionally sinks the domain model as docs while you grill:
1. "/grill-with-docs <query>" grills that query and writes docs. A bare "/grill-with-docs" grills the user's most recent substantive request and writes docs.
2. During the rounds, use grill_docs_read to check the current CONTEXT.md glossary, CONTEXT-MAP.md, and docs/adr/ numbering before proposing terms or decisions — never guess or duplicate.
3. When a term crystallizes, call grill_docs_update with kind=term: one canonical term, a one-two sentence definition of what it IS, an optional _Avoid_ list, and an optional grouping section. Update CONTEXT.md inline as terms resolve — do not batch them.
4. Offer ADRs sparingly with grill_docs_update kind=adr only when ALL three hold: hard to reverse, surprising without context, and the result of a real trade-off. Use the next sequential number (0001, 0002, ...) that grill_docs_read reports; the body is a 1-3 sentence summary plus optional status/considered/consequences.
5. Challenge conflicting or fuzzy terms immediately, stress-test domain relationships with concrete scenarios, and cross-reference claims against the code — then persist the resolution with grill_docs_update.
6. The disk is the source of truth: every grill_docs_update writes CONTEXT.md or docs/adr/000N-*.md under the workspace docs root and records a grill-me/docs-updated event. Never hand-edit those files with other tools during a grill-with-docs session.`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: GrillToolsConfig = {
    stateDir: config.stateDir ?? '.grill-me',
  }
  const docsResolved: DocsToolsConfig = {
    stateDir: config.stateDir ?? '.grill-me',
    docsDir: config.docsDir ?? '',
    docsEnabled: config.docsEnabled ?? true,
  }
  ctx.systemPrompt.section({
    name: 'grill-me:usage',
    order: config.promptSectionOrder ?? 118,
    text: usageSectionText(),
  })
  ctx.systemPrompt.section({
    name: 'grill-me:docs-usage',
    order: (config.promptSectionOrder ?? 118) + 1,
    text: docsUsageSectionText(),
  })
  registerGrillTools(ctx, resolved)
  registerGrillDocsTools(ctx, docsResolved)
  registerGrillCommand(ctx)
  registerGrillDocsCommand(ctx)
}
