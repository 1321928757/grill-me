#!/usr/bin/env node
/**
 * Deterministic concurrency and isolation verification for the compiled
 * grill_* tools: duplicate sessions, unknown sessions, cross-session
 * isolation, concurrent answers, stale writes after settle, and repeated
 * archive. Requires a prior `pnpm build` (lib/ present).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { registerGrillTools } from '../lib/tools.js'
import { registerGrillDocsTools } from '../lib/docs.js'
import { readSession } from '../lib/state.js'

const workspace = await mkdtemp(join(tmpdir(), 'dsh-grill-me-stress-'))
const stateRoot = join(workspace, '.grill-me')
const definitions = new Map()

const userQuestions = {
  ask: async () => ({ answers: [] }),
}

const ctx = {
  effect(setup) {
    return setup()
  },
  tools: {
    register(definition) {
      definitions.set(definition.name, definition)
    },
  },
  on() {
    return () => {}
  },
  logger: { debug() {}, warn() {} },
  userQuestions,
}
registerGrillTools(ctx, { stateDir: '.grill-me' })
registerGrillDocsTools(ctx, { stateDir: '.grill-me', docsDir: '', docsEnabled: true })

const exec = {
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: workspace }, append() {} } },
}

let failures = 0
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL'
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures += 1
}

async function call(name, args) {
  const definition = definitions.get(name)
  if (!definition) throw new Error(`missing tool ${name}`)
  const result = await definition.execute(args, exec)
  const detached = snapshotJsonValue(result)
  if (detached === undefined) {
    throw new Error(`tool ${name} returned a non-lossless JSON value`)
  }
  const violations = validateJsonSchemaValue(definition.output.schema, detached, 'value')
  if (violations.length > 0) {
    throw new Error(`tool ${name} output violates its schema: ${violations.join('; ')}`)
  }
  return result
}

async function rejected(name, args, label) {
  try {
    await call(name, args)
    check(label, false, 'expected the call to fail')
  } catch {
    check(label, true)
  }
}

console.log('dsh-grill-me stress verification')
try {
  await call('grill_begin', { query: 'duplicate test' })
  await rejected('grill_begin', { query: 'duplicate test' }, 'duplicate grill_begin is rejected')
  await rejected('grill_question', {
    session_id: 'missing',
    question_id: 'q1',
    question: 'Q?',
    recommendation: 'A',
  }, 'unknown session is rejected')

  await call('grill_begin', { query: 'alpha' })
  await call('grill_begin', { query: 'beta' })
  await call('grill_question', { session_id: 'alpha', question_id: 'scope', question: 'Scope?', recommendation: 'MVP' })
  await rejected('grill_answer', { session_id: 'beta', question_id: 'scope', answer: 'US' }, 'answers cannot cross sessions')
  check('sessions stay isolated on disk', (await readSession(stateRoot, 'alpha'))?.decisions.length === 1 && (await readSession(stateRoot, 'beta'))?.decisions.length === 0)

  await call('grill_begin', { query: 'race' })
  await call('grill_question', { session_id: 'race', question_id: 'q1', question: 'Q1?', recommendation: 'A1' })
  await call('grill_question', { session_id: 'race', question_id: 'q2', question: 'Q2?', recommendation: 'A2' })
  const concurrent = await Promise.all([
    call('grill_answer', { session_id: 'race', question_id: 'q1', answer: 'A1' }),
    call('grill_answer', { session_id: 'race', question_id: 'q2', answer: 'A2' }),
  ])
  check('concurrent answers serialize and drain the frontier', concurrent.map(result => result.remaining).sort().join(',') === '0,1')
  check('concurrent answers leave no live frontier', (await readSession(stateRoot, 'race'))?.decisions.every(decision => decision.answer !== undefined) === true)
  await call('grill_settle', { session_id: 'race', boundary: 'both decisions settled' })
  await rejected('grill_answer', { session_id: 'race', question_id: 'q1', answer: 'late' }, 'stale answer after settle is rejected')

  await call('grill_archive', { session_id: 'race' })
  check('archived session leaves no live state', await readSession(stateRoot, 'race') === undefined)
  await rejected('grill_archive', { session_id: 'race' }, 'repeated archive is rejected')

  await rejected('grill_ask', { session_id: 'missing' }, 'grill_ask on an unknown session is rejected')

  await call('grill_begin', { query: 'card idle' })
  const idle = await call('grill_ask', { session_id: 'card-idle' })
  check('grill_ask with an empty frontier and no boundary is a no-op', idle.remaining === 0 && idle.status === 'open')

  await call('grill_begin', { query: 'card settle' })
  await call('grill_question', { session_id: 'card-settle', question_id: 'scope', question: 'Scope?', recommendation: 'A', options: ['A', 'B', 'C'] })
  userQuestions.ask = async () => ({ answers: [{ id: 'scope', selected: ['A (Recommended)'] }] })
  const cardRound = await call('grill_ask', { session_id: 'card-settle' })
  check('grill_ask records and drains a single-decision frontier', cardRound.remaining === 0 && cardRound.answers.length === 1)
  userQuestions.ask = async () => ({ answers: [{ id: 'settle-confirm', selected: ['确认，按此边界执行 (Recommended)'] }] })
  const cardSettled = await call('grill_ask', { session_id: 'card-settle', boundary: 'card settle boundary' })
  check('grill_ask settles through the confirmation card', cardSettled.status === 'settled' && cardSettled.boundary === 'card settle boundary')
  await rejected('grill_ask', { session_id: 'card-settle', boundary: 'late' }, 'grill_ask on a settled session is rejected')

  await call('grill_begin', { query: 'multi option' })
  await call('grill_question', { session_id: 'multi-option', question_id: 'scope', question: 'Scope?', recommendation: 'A', options: ['A', 'B', 'C', 'D'] })
  await call('grill_question', { session_id: 'multi-option', question_id: 'delivery', question: 'Delivery?', recommendation: 'Cloud', options: ['Cloud', 'On-prem'] })
  userQuestions.ask = async (request) => {
    check('multi-option frontier renders both decisions with their choices',
      request.questions.length === 2
      && request.questions[0]?.options?.length === 4
      && request.questions[1]?.options?.length === 2)
    return { answers: [
      { id: 'scope', selected: ['B'] },
      { id: 'delivery', selected: ['Cloud (Recommended)'] },
    ] }
  }
  const multiRound = await call('grill_ask', { session_id: 'multi-option' })
  check('multi-option answers record verbatim and stripped markers',
    multiRound.remaining === 0
    && multiRound.answers.length === 2
    && multiRound.answers.some(answer => answer.id === 'scope' && answer.answer === 'B')
    && multiRound.answers.some(answer => answer.id === 'delivery' && answer.answer === 'Cloud'))

  userQuestions.ask = async () => {
    const error = new Error('no user-questions provider is registered')
    error.code = 'NO_PROVIDER'
    throw error
  }
  await rejected('grill_ask', { session_id: 'card-idle', boundary: 'x' }, 'grill_ask without a UI provider is rejected')

  // grill_docs isolation: sessions share the workspace docs root but the
  // session gate is per-session; docs writes must not cross sessions.
  await call('grill_begin', { query: 'docs alpha' })
  await call('grill_docs_update', { session_id: 'docs-alpha', kind: 'term', term: 'Alpha', definition: 'The alpha concept.' })
  await rejected('grill_docs_read', { session_id: 'missing' }, 'grill_docs_read on an unknown session is rejected')
  await rejected('grill_docs_update', { session_id: 'docs-alpha', kind: 'term', term: 'Beta' }, 'grill_docs_update with a missing definition is rejected')
  const docsRead = await call('grill_docs_read', { session_id: 'docs-alpha', scope: 'context' })
  check('grill_docs_read sees the term written by its own session', docsRead.context?.includes('**Alpha**:') === true)
} finally {
  await rm(workspace, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nstress checks passed')