import { join } from 'node:path'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
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
import type { GrillDecision, GrillSession } from './types.ts'

export interface GrillToolsConfig {
  stateDir: string
}

interface CallerAgent {
  session: {
    header: { cwd?: string }
  }
}

/** Structural slice of the tool execution context we read; the rest is framework-owned. */
interface GrillExecContext {
  agent?: CallerAgent
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

function render(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

type DecisionJson = { [key: string]: JsonValue }

function decisionSummary(decision: GrillDecision): DecisionJson {
  return {
    id: decision.id,
    question: decision.question,
    recommendation: decision.recommendation,
    prerequisites: decision.prerequisites,
    answer: decision.answer ?? null,
    answeredAt: decision.answeredAt ?? null,
  }
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
        appendGrillEvent(exec.agent, 'grill-me/session-created', { sessionId: id, query: args.query })
        return { session_id: id, query: args.query }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grill_question',
    description: 'Add one decision to the design tree. Its prerequisites must be settled decisions; the decision becomes part of the frontier and must not be asked before its prerequisites are answered.',
    parameters: {
      session_id: { type: 'string', required: true },
      question_id: { type: 'string', required: true, description: 'Stable decision id, e.g. "scope".' },
      question: { type: 'string', required: true },
      recommendation: { type: 'string', required: true, description: 'The agent-recommended answer the user can accept.' },
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
    async execute(args: { session_id: string; question_id: string; question: string; recommendation: string; prerequisites?: string[] }, exec: GrillExecContext) {
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${args.session_id}`, async () => {
        const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
        const updated = addDecision(session, {
          id: args.question_id,
          question: args.question,
          recommendation: args.recommendation,
          prerequisites: args.prerequisites,
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
        appendGrillEvent(exec.agent, 'grill-me/decision-answered', {
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
      return {
        session_id: session.id,
        status: session.status,
        frontier: frontierOf(session).map(decisionSummary),
        settled: session.decisions.filter(decision => decision.answer !== undefined).map(decisionSummary),
        boundary: session.boundary,
      }
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
        appendGrillEvent(exec.agent, 'grill-me/session-settled', { sessionId: updated.id, boundary: args.boundary })
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
        appendGrillEvent(exec.agent, 'grill-me/session-archived', { sessionId: updated.id, reason: args.reason })
        return { session_id: updated.id, status: updated.status }
      })
    },
  }))
}