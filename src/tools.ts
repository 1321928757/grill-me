import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { appendGrillEvent } from './events.ts'
import {
  addDecision,
  answerDecision,
  archiveSession,
  archiveStatus,
  createSession,
  frontierOf,
  readSession,
  sanitizeKey,
  settleSession,
  withSessionLock,
  writeSession,
} from './state.ts'
import type { GrillDecision, GrillSession, GrillStatus } from './types.ts'

export interface GrillToolsConfig {
  stateDir: string
  /** Minimum number of options a question card should carry (default 3); no upper bound. */
  optionCount?: number
}

/**
 * Minimal structural contract of the DSH `user-questions` capability, declared
 * locally so the plugin stays dependency-free: the runtime service object is
 * composed by the host (`@deepseek-ai/dsh-user-questions`), and any caller of
 * `ctx.userQuestions.ask()` renders the same question-card UI in the web GUI.
 */
export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: {
      ask(request: {
        questions: AskUserQuestionItem[]
        agent?: Agent
        signal?: AbortSignal
      }): Promise<AskUserQuestionAnswer>
    }
  }
}

/** Structural slice of the tool execution context we read; the rest is framework-owned. */
interface GrillExecContext {
  agent?: Agent
  signal: AbortSignal
}

function requireSession(session: GrillSession | undefined, sessionId: string): GrillSession {
  if (!session) throw new Error(`unknown grill session "${sessionId}"`)
  return session
}

function workspaceOf(exec: GrillExecContext): string {
  const workspace = exec.agent?.session.header.cwd
  if (!workspace) throw new Error('grill-me: caller has no workspace')
  return workspace
}

/**
 * Project one tool result onto model-visible content.
 *
 * DSH calls `output.render(exec.arguments, value)`; taking the value first is
 * the only way the model sees the result instead of its own call arguments.
 */
function render(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

type DecisionJson = { [key: string]: JsonValue }

function decisionSummary(decision: GrillDecision): DecisionJson {
  return {
    id: decision.id,
    question: decision.question,
    recommendation: decision.recommendation,
    prerequisites: decision.prerequisites,
    options: decision.options ?? null,
    answer: decision.answer ?? null,
    answeredAt: decision.answeredAt ?? null,
  }
}

/** The "(Recommended)" / "（推荐）" marker the card UI turns into the 推荐 badge. */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i

/** Strip the recommendation marker from an option label; the stored answer is the bare label. */
export function stripRecommendedSuffix(value: string): string {
  return value.replace(RECOMMENDED_SUFFIX, '').trim()
}

/**
 * Card options for one frontier decision: the decision's own 2-4 choices with
 * the first (the recommended answer) marked `(Recommended)`, or the legacy
 * single-option card built from `recommendation` when no `options` exist.
 */
export function cardOptionsOf(decision: GrillDecision): AskUserQuestionOption[] {
  if (decision.options !== undefined && decision.options.length > 0) {
    return decision.options.map((option, index) => ({
      label: index === 0 ? `${option.trim()} (Recommended)` : option.trim(),
    }))
  }
  return decision.recommendation.trim() === '' ? [] : [{ label: `${decision.recommendation.trim()} (Recommended)` }]
}

/** One card answer item -> the design-tree answer text; '' means the user skipped. */
export function cardAnswerText(item: AskUserQuestionAnswerItem): string {
  const custom = (item.custom ?? '').trim()
  if (custom !== '') return custom
  const selected = item.selected[0]
  return selected === undefined ? '' : stripRecommendedSuffix(selected)
}

export function registerGrillTools(ctx: Context, config: GrillToolsConfig): void {
  const stateRootOf = (exec: GrillExecContext) => join(workspaceOf(exec), config.stateDir)

  ctx.tools.register(defineTool({
    name: 'grill_begin',
    description: 'Start a grill session for one user query. The session is open until every frontier question is answered and the boundary is settled.',
    parameters: {
      query: { type: 'string', required: true, description: 'The user query whose boundaries need to be explicit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          query: { type: 'string', required: true },
        },
      },
      render,
    },
    async execute(args: { query: string }, exec: GrillExecContext) {
      const id = sanitizeKey(args.query)
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${id}`, async () => {
        const existing = await readSession(stateRoot, id)
        if (existing) throw new Error(`grill session "${id}" already exists; archive it before starting another`)
        const session: GrillSession = {
          id,
          query: args.query,
          status: 'open',
          decisions: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        await createSession(stateRoot, session)
        appendGrillEvent(exec.agent, 'plugin:grill-me/session-created', { sessionId: id, query: args.query })
        return { session_id: id, query: args.query }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grill_question',
    description: 'Add one decision to the design tree. Its prerequisites must be settled decisions; the decision becomes part of the frontier and must not be asked before its prerequisites are answered. '
      + `Pass at least ${config.optionCount ?? 3} choices in \`options\` to render a multi-option card (the recommended answer must be the first choice and is marked 推荐); omit \`options\` for the single-option card fallback.`,
    parameters: {
      session_id: { type: 'string', required: true },
      question_id: { type: 'string', required: true, description: 'Stable decision id, e.g. "scope".' },
      question: { type: 'string', required: true },
      recommendation: { type: 'string', required: true, description: 'The agent-recommended answer the user can accept; must be the first entry of `options` when provided.' },
      options: { type: 'array', items: { type: 'string' }, description: `At least ${config.optionCount ?? 3} choices for a multi-option card (no upper bound); the first entry is the recommended answer.` },
      prerequisites: { type: 'array', items: { type: 'string' }, description: 'Ids of decisions that must be answered first.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          question_id: { type: 'string', required: true },
          frontier: { type: 'array', required: true },
        },
      },
      render,
    },
    async execute(args: { session_id: string; question_id: string; question: string; recommendation: string; options?: string[]; prerequisites?: string[] }, exec: GrillExecContext) {
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${args.session_id}`, async () => {
        const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
        const updated = addDecision(session, {
          id: args.question_id,
          question: args.question,
          recommendation: args.recommendation,
          prerequisites: args.prerequisites,
          options: args.options,
          minOptions: config.optionCount ?? 3,
        })
        await writeSession(stateRoot, updated)
        return { session_id: updated.id, question_id: args.question_id, frontier: frontierOf(updated).map(decisionSummary) }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grill_answer',
    description: 'Record the user answer to one frontier decision. The answer freezes that decision and expands the frontier.',
    parameters: {
      session_id: { type: 'string', required: true },
      question_id: { type: 'string', required: true },
      answer: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          question_id: { type: 'string', required: true },
          frontier: { type: 'array', required: true },
          remaining: { type: 'integer', required: true },
        },
      },
      render,
    },
    async execute(args: { session_id: string; question_id: string; answer: string }, exec: GrillExecContext) {
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${args.session_id}`, async () => {
        const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
        const updated = answerDecision(session, args.question_id, args.answer)
        await writeSession(stateRoot, updated)
        const frontier = frontierOf(updated)
        appendGrillEvent(exec.agent, 'plugin:grill-me/decision-answered', {
          sessionId: updated.id,
          questionId: args.question_id,
          answer: args.answer,
        })
        return { session_id: updated.id, question_id: args.question_id, frontier: frontier.map(decisionSummary), remaining: frontier.length }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grill_frontier',
    description: 'Return the current design tree, settled decisions, frontier questions with recommendations, and boundary status.',
    parameters: {
      session_id: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          frontier: { type: 'array', required: true },
          settled: { type: 'array', required: true },
          boundary: { type: 'string' },
        },
      },
      render,
    },
    async execute(args: { session_id: string }, exec: GrillExecContext) {
      const stateRoot = stateRootOf(exec)
      const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
      const result: {
        session_id: string
        status: GrillStatus
        frontier: DecisionJson[]
        settled: DecisionJson[]
        boundary?: string
      } = {
        session_id: session.id,
        status: session.status,
        frontier: frontierOf(session).map(decisionSummary),
        settled: session.decisions.filter(decision => decision.answer !== undefined).map(decisionSummary),
      }
      // The harness rejects any tool value containing `undefined` as "not
      // lossless JSON"; an open session has no boundary yet, so the key is
      // omitted until settle freezes one.
      if (session.boundary !== undefined) result.boundary = session.boundary
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grill_settle',
    description: 'Freeze the shared understanding once the frontier is empty. The boundary spec becomes the explicit query contract the agent then executes against.',
    parameters: {
      session_id: { type: 'string', required: true },
      boundary: { type: 'string', required: true, description: 'Explicit boundary spec agreed with the user.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          boundary: { type: 'string', required: true },
        },
      },
      render,
    },
    async execute(args: { session_id: string; boundary: string }, exec: GrillExecContext) {
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${args.session_id}`, async () => {
        const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
        const updated = settleSession(session, args.boundary)
        await writeSession(stateRoot, updated)
        appendGrillEvent(exec.agent, 'plugin:grill-me/session-settled', { sessionId: updated.id, boundary: args.boundary })
        return { session_id: updated.id, status: updated.status, boundary: updated.boundary ?? '' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grill_archive',
    description: 'End a grill session and move it to the archive. Settled sessions keep their full design tree for later review.',
    parameters: {
      session_id: { type: 'string', required: true },
      reason: { type: 'string', description: 'Why the session is being closed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render,
    },
    async execute(args: { session_id: string; reason?: string }, exec: GrillExecContext) {
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${args.session_id}`, async () => {
        const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
        const updated = archiveStatus(session)
        if (updated.status !== session.status) await writeSession(stateRoot, updated)
        await archiveSession(stateRoot, updated.id)
        appendGrillEvent(exec.agent, 'plugin:grill-me/session-archived', { sessionId: updated.id, reason: args.reason })
        return { session_id: updated.id, status: updated.status }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grill_ask',
    description: 'Ask the user through the DSH question-card UI, the only allowed presentation for frontier rounds. '
      + 'With an open frontier it renders every frontier decision as a card (the recommended answer is the first option, '
      + 'marked 推荐, plus a custom-answer field) and writes the recorded answers into the design tree automatically. '
      + 'With an empty frontier and a boundary it returns the boundary text for confirmation WITHOUT rendering a card: '
      + 'ask the user in plain text, then freeze the boundary with grill_settle once they approve. '
      + 'In environments without a question-card UI it fails with a user-questions-unavailable error; then ask in plain text '
      + 'and record answers with grill_answer instead.',
    parameters: {
      session_id: { type: 'string', required: true },
      boundary: { type: 'string', description: 'Explicit boundary spec to confirm once the frontier is empty; returned as text for plain-text confirmation, then frozen via grill_settle.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          answers: { type: 'array', required: true },
          frontier: { type: 'array', required: true },
          remaining: { type: 'integer', required: true },
          boundary: { type: 'string' },
          modification: { type: 'string' },
        },
      },
      render,
    },
    async execute(args: { session_id: string; boundary?: string }, exec: GrillExecContext) {
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${args.session_id}`, async () => {
        const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
        if (session.status !== 'open') {
          throw new Error(`session is ${session.status}; only open sessions accept questions`)
        }
        const frontier = frontierOf(session)
        if (frontier.length > 0) {
          const answer = await askViaCards(ctx, exec, frontier.map(decision => ({
            id: decision.id,
            question: decision.question,
            header: decision.id,
            options: cardOptionsOf(decision),
          })))
          let updated = session
          const recorded: { id: string; answer: string }[] = []
          for (const item of answer.answers) {
            if (!frontier.some(decision => decision.id === item.id)) continue
            const text = cardAnswerText(item)
            if (text === '') continue // skipped: the decision stays on the frontier
            updated = answerDecision(updated, item.id, text)
            recorded.push({ id: item.id, answer: text })
          }
          if (updated !== session) await writeSession(stateRoot, updated)
          const next = frontierOf(updated)
          appendGrillEvent(exec.agent, 'plugin:grill-me/frontier-asked', {
            sessionId: updated.id,
            answers: recorded.map(item => ({ questionId: item.id, answer: item.answer })),
            remaining: next.length,
          })
          return {
            session_id: updated.id,
            status: updated.status,
            answers: recorded,
            frontier: next.map(decisionSummary),
            remaining: next.length,
          }
        }
        const boundary = (args.boundary ?? '').trim()
        if (boundary === '') {
          return { session_id: session.id, status: session.status, answers: [], frontier: [], remaining: 0 }
        }
        // Settle confirmation is plain-text: no card interaction. Return the
        // boundary (status stays open); the agent asks the user in text and
        // freezes it with grill_settle on approval.
        return {
          session_id: session.id,
          status: session.status,
          answers: [],
          frontier: [],
          remaining: 0,
          boundary,
        }
      })
    },
  }))
}

/**
 * Render one question batch through the DSH question-card UI. The card is
 * capability-keyed, so any caller of `ctx.userQuestions.ask()` — not just the
 * preset-composed `ask_user_question` tool — gets the identical web-GUI card.
 */
async function askViaCards(
  ctx: Context,
  exec: GrillExecContext,
  questions: AskUserQuestionItem[],
): Promise<AskUserQuestionAnswer> {
  const service = (ctx as { userQuestions?: Context['userQuestions'] }).userQuestions
  if (service === undefined) {
    throw new Error('grill_ask unavailable: no user-questions service (user-questions-unavailable); ask in plain text and record answers with grill_answer')
  }
  try {
    return await service.ask({
      questions,
      ...exec.agent !== undefined ? { agent: exec.agent } : {},
      signal: exec.signal,
    })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'NO_PROVIDER') {
      throw new Error('grill_ask unavailable: no user-questions provider (user-questions-unavailable); ask in plain text and record answers with grill_answer')
    }
    throw error
  }
}