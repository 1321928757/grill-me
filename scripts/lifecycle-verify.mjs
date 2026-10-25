#!/usr/bin/env node
/**
 * Drives the compiled grill_* tools through one full lifecycle:
 * begin -> question -> blocked prereq -> answer -> settle -> archive,
 * plus the grill_ask card flow (frontier cards, text-based settle
 * confirmation, skip, no-provider fallback), then verifies the /grill-me
 * and /grill-with-docs host command registration and steering. Requires a
 * prior `pnpm build` (lib/ present).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { GRILL_COMMAND, GRILL_DOCS_COMMAND, grillDocsLine, grillLine, registerGrillCommand, registerGrillDocsCommand } from '../lib/command.js'
import { registerGrillTools } from '../lib/tools.js'
import { cardAnswerText, cardOptionsOf, stripRecommendedSuffix } from '../lib/tools.js'
import { registerGrillDocsTools } from '../lib/docs.js'
import { readSession } from '../lib/state.js'

const workspace = await mkdtemp(join(tmpdir(), 'dsh-grill-me-lifecycle-'))
const stateRoot = join(workspace, '.grill-me')
const definitions = new Map()

/** Swappable question-card provider the grill_ask scenarios drive. */
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

const events = []
const exec = {
  signal: new AbortController().signal,
  agent: {
    session: {
      header: { cwd: workspace },
      append(type, data) {
        events.push({ type, data })
      },
    },
  },
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
  // DSH renders with `output.render(exec.arguments, value)`. The model only
  // sees this content, so it must project the RESULT and never the call
  // arguments — the 0.0.1 build shipped `render(value)`, which handed the
  // model its own arguments and hid every frontier.
  const rendered = definition.output.render(args, result)
  const text = rendered.map(block => block.text).join('')
  if (text !== JSON.stringify(detached)) {
    throw new Error(`tool ${name} renders something other than its result: ${text.slice(0, 120)}`)
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

console.log('dsh-grill-me lifecycle verification')
try {
  const begun = await call('grill_begin', { query: 'build a trading bot' })
  check('grill_begin creates the session', begun.session_id === 'build-a-trading-bot')
  let session = await readSession(stateRoot, begun.session_id)
  check('session starts open', session?.status === 'open' && session?.decisions.length === 0)

  const frontierOpen = await call('grill_frontier', { session_id: begun.session_id })
  check('grill_frontier on an open session is lossless JSON', !('boundary' in frontierOpen), JSON.stringify(frontierOpen))

  const scope = await call('grill_question', {
    session_id: begun.session_id,
    question_id: 'scope',
    question: 'Which scope?',
    recommendation: 'MVP only',
  })
  check('first question enters the frontier', scope.frontier.length === 1 && scope.frontier[0]?.id === 'scope')

  await rejected('grill_question', {
    session_id: begun.session_id,
    question_id: 'market',
    question: 'Which market?',
    recommendation: 'US',
    prerequisites: ['scope'],
  }, 'question with an unsettled prerequisite is rejected')

  await rejected('grill_question', {
    session_id: begun.session_id,
    question_id: 'bad-options',
    question: 'Bad options?',
    recommendation: 'US',
    options: ['US'],
  }, 'question with fewer than 2 options is rejected')
  await rejected('grill_question', {
    session_id: begun.session_id,
    question_id: 'bad-first',
    question: 'Bad first option?',
    recommendation: 'US',
    options: ['EU', 'US', 'APAC'],
  }, 'question whose first option is not the recommendation is rejected')

  await call('grill_answer', { session_id: begun.session_id, question_id: 'scope', answer: 'MVP only' })
  await call('grill_question', {
    session_id: begun.session_id,
    question_id: 'market',
    question: 'Which market?',
    recommendation: 'US',
    prerequisites: ['scope'],
  })
  const answered = await call('grill_answer', { session_id: begun.session_id, question_id: 'market', answer: 'US' })
  check('frontier drains after the last answer', answered.remaining === 0)

  await rejected('grill_settle', { session_id: begun.session_id, boundary: ' ' }, 'empty boundary is rejected')
  const settled = await call('grill_settle', {
    session_id: begun.session_id,
    boundary: 'MVP for US users only',
  })
  check('grill_settle freezes the boundary', settled.status === 'settled' && settled.boundary === 'MVP for US users only')

  const frontierSettled = await call('grill_frontier', { session_id: begun.session_id })
  check('grill_frontier after settle reports the boundary', frontierSettled.boundary === 'MVP for US users only')

  await rejected('grill_question', {
    session_id: begun.session_id,
    question_id: 'late',
    question: 'Late question?',
    recommendation: 'no',
  }, 'question after settle is rejected')
  await rejected('grill_answer', {
    session_id: begun.session_id,
    question_id: 'scope',
    answer: 'another',
  }, 'answer after settle is rejected')

  const archived = await call('grill_archive', { session_id: begun.session_id, reason: 'done' })
  check('grill_archive moves the session to archive', archived.status === 'archived')
  check('live reads no longer see the session', await readSession(stateRoot, begun.session_id) === undefined)
  const archivedSession = await readFile(join(stateRoot, 'archive', begun.session_id, 'session.json'), 'utf8')
  check('archived tree keeps the boundary', archivedSession.includes('MVP for US users only'))
  check('session-created event emitted', events.some(event => event.type === 'plugin:grill-me/session-created'))
  check('decision-answered events emitted', events.filter(event => event.type === 'plugin:grill-me/decision-answered').length === 2)
  check('session-settled event emitted', events.some(event => event.type === 'plugin:grill-me/session-settled'))
  check('session-archived event emitted', events.some(event => event.type === 'plugin:grill-me/session-archived'))
} finally {
  await rm(workspace, { recursive: true, force: true })
}

// --- grill_ask: question-card flow ---

console.log('\ngrill_ask card-flow verification')
const cardWorkspace = await mkdtemp(join(tmpdir(), 'dsh-grill-me-cards-'))
const cardStateRoot = join(cardWorkspace, '.grill-me')
const cardExec = {
  signal: new AbortController().signal,
  agent: {
    session: {
      header: { cwd: cardWorkspace },
      append(type, data) {
        events.push({ type, data })
      },
    },
  },
}

async function callCard(name, args) {
  const definition = definitions.get(name)
  if (!definition) throw new Error(`missing tool ${name}`)
  const result = await definition.execute(args, cardExec)
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

async function rejectedCard(name, args, label) {
  try {
    await callCard(name, args)
    check(label, false, 'expected the call to fail')
  } catch {
    check(label, true)
  }
}

try {
  check("stripRecommendedSuffix strips the ASCII marker", stripRecommendedSuffix('MVP only (Recommended)') === 'MVP only')
  check("stripRecommendedSuffix strips the CJK marker", stripRecommendedSuffix('MVP only（推荐）') === 'MVP only')
  check("cardAnswerText prefers custom over selected", cardAnswerText({ id: 'a', selected: ['X (Recommended)'], custom: '  my answer  ' }) === 'my answer')
  check("cardAnswerText falls back to the stripped selected label", cardAnswerText({ id: 'a', selected: ['US (Recommended)'] }) === 'US')
  check("cardAnswerText returns '' for a skipped answer", cardAnswerText({ id: 'a', selected: [] }) === '')
  check('cardAnswerText reads a non-first selected option verbatim', cardAnswerText({ id: 'a', selected: ['On-prem'] }) === 'On-prem')
  check("cardOptionsOf marks only the first option as recommended",
    JSON.stringify(cardOptionsOf({ id: 'a', question: 'Q', recommendation: 'Cloud', prerequisites: [], options: ['Cloud', 'On-prem', 'Hybrid'] }).map(option => option.label))
    === JSON.stringify(['Cloud (Recommended)', 'On-prem', 'Hybrid']))
  check('cardOptionsOf falls back to the single-option card without options',
    JSON.stringify(cardOptionsOf({ id: 'a', question: 'Q', recommendation: 'MVP only', prerequisites: [] }).map(option => option.label))
    === JSON.stringify(['MVP only (Recommended)']))

  await callCard('grill_begin', { query: 'card flow' })
  await callCard('grill_question', {
    session_id: 'card-flow',
    question_id: 'scope',
    question: 'Which scope?',
    recommendation: 'MVP only',
    options: ['MVP only', 'Full', 'Research'],
  })

  userQuestions.ask = async (request) => {
    check('frontier cards carry the decision ids', request.questions.length === 1 && request.questions[0]?.id === 'scope')
    check('frontier cards render every option with the recommendation first',
      request.questions[0]?.options?.length === 3
      && request.questions[0]?.options?.[0]?.label === 'MVP only (Recommended)'
      && request.questions[0]?.options?.[1]?.label === 'Full'
      && request.questions[0]?.options?.[2]?.label === 'Research')
    return { answers: [{ id: 'scope', selected: ['MVP only (Recommended)'] }] }
  }
  const asked = await callCard('grill_ask', { session_id: 'card-flow' })
  check('grill_ask records the recommended answer without the marker',
    asked.answers.length === 1 && asked.answers[0]?.answer === 'MVP only')

  const unlocked = await callCard('grill_question', {
    session_id: 'card-flow',
    question_id: 'market',
    question: 'Which market?',
    recommendation: 'US',
    options: ['US', 'EU', 'APAC'],
    prerequisites: ['scope'],
  })
  check('an answered prerequisite unlocks the next decision via cards',
    unlocked.frontier.length === 1 && unlocked.frontier[0]?.id === 'market')
  check('frontier summaries expose the decision options',
    JSON.stringify(unlocked.frontier[0]?.options) === JSON.stringify(['US', 'EU', 'APAC']))
  userQuestions.ask = async () => ({ answers: [{ id: 'market', selected: ['EU'] }] })
  const askedOption = await callCard('grill_ask', { session_id: 'card-flow' })
  check('grill_ask records a non-first option verbatim', askedOption.answers[0]?.answer === 'EU')
  check('frontier drains after the last card answer', askedOption.remaining === 0)
  check('frontier-asked events emitted', events.filter(event => event.type === 'plugin:grill-me/frontier-asked').length === 2)

  let settleCardRendered = false
  userQuestions.ask = async (request) => {
    settleCardRendered = true
    return { answers: [] }
  }
  const boundaryText = await callCard('grill_ask', { session_id: 'card-flow', boundary: 'card boundary' })
  check('grill_ask with an empty frontier returns the boundary text without rendering a settle card',
    !settleCardRendered && boundaryText.status === 'open' && boundaryText.boundary === 'card boundary')
  const settledByText = await callCard('grill_settle', { session_id: 'card-flow', boundary: 'card boundary' })
  check('grill_settle freezes the boundary after text confirmation', settledByText.status === 'settled' && settledByText.boundary === 'card boundary')
  check('settle confirmation emits the session-settled event', events.some(event => event.type === 'plugin:grill-me/session-settled'))

  await callCard('grill_begin', { query: 'custom option' })
  await callCard('grill_question', {
    session_id: 'custom-option',
    question_id: 'scope',
    question: 'Scope?',
    recommendation: 'A',
    options: ['A', 'B', 'C'],
  })
  userQuestions.ask = async () => ({ answers: [{ id: 'scope', selected: ['B'], custom: '  custom scope  ' }] })
  const askedCustom = await callCard('grill_ask', { session_id: 'custom-option' })
  check('grill_ask prefers a custom answer over a selected option', askedCustom.answers[0]?.answer === 'custom scope')

  await callCard('grill_begin', { query: 'text settle' })
  await callCard('grill_question', { session_id: 'text-settle', question_id: 'scope', question: 'Scope?', recommendation: 'A', options: ['A', 'B', 'C'] })
  userQuestions.ask = async () => ({ answers: [{ id: 'scope', selected: ['A (Recommended)'] }] })
  await callCard('grill_ask', { session_id: 'text-settle' })
  let declinedCardRendered = false
  userQuestions.ask = async () => {
    declinedCardRendered = true
    return { answers: [] }
  }
  const textBoundary = await callCard('grill_ask', { session_id: 'text-settle', boundary: 'text boundary' })
  check('a text-confirmed settle stays open with the boundary and renders no card',
    !declinedCardRendered && textBoundary.status === 'open' && textBoundary.boundary === 'text boundary')
  check('a text-confirmed settle froze nothing on disk yet', (await readSession(cardStateRoot, 'text-settle'))?.status === 'open')

  await callCard('grill_begin', { query: 'skipped answer' })
  await callCard('grill_question', { session_id: 'skipped-answer', question_id: 'scope', question: 'Scope?', recommendation: 'A' })
  userQuestions.ask = async () => ({ answers: [{ id: 'scope', selected: [] }] })
  const skipped = await callCard('grill_ask', { session_id: 'skipped-answer' })
  check('a skipped card answer keeps the decision open', skipped.remaining === 1 && skipped.answers.length === 0)

  userQuestions.ask = async () => {
    const error = new Error('no user-questions provider is registered')
    error.code = 'NO_PROVIDER'
    throw error
  }
  await rejectedCard('grill_ask', { session_id: 'skipped-answer' }, 'grill_ask without a UI provider is rejected')

  const serviceRef = ctx.userQuestions
  delete ctx.userQuestions
  await rejectedCard('grill_ask', { session_id: 'skipped-answer' }, 'grill_ask without a user-questions service is rejected')
  ctx.userQuestions = serviceRef
} finally {
  await rm(cardWorkspace, { recursive: true, force: true })
}

// --- grill_docs tools ---

console.log('\ngrill_docs tool verification')
const docsWorkspace = await mkdtemp(join(tmpdir(), 'dsh-grill-me-docs-'))
const docsStateRoot = join(docsWorkspace, '.grill-me')
const docsExec = {
  signal: new AbortController().signal,
  agent: {
    session: {
      header: { cwd: docsWorkspace },
      append(type, data) {
        events.push({ type, data })
      },
    },
  },
}

async function callDocs(name, args) {
  const definition = definitions.get(name)
  if (!definition) throw new Error(`missing tool ${name}`)
  const result = await definition.execute(args, docsExec)
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

async function rejectedDocs(name, args, label) {
  try {
    await callDocs(name, args)
    check(label, false, 'expected the call to fail')
  } catch {
    check(label, true)
  }
}

try {
  await callDocs('grill_begin', { query: 'docs flow' })
  const readEmpty = await callDocs('grill_docs_read', { session_id: 'docs-flow' })
  check('grill_docs_read on a bare workspace reports single layout and no docs',
    readEmpty.layout === 'single' && readEmpty.adrs.length === 0 && readEmpty.next_adr === 1 && !('context' in readEmpty))

  const termWritten = await callDocs('grill_docs_update', {
    session_id: 'docs-flow',
    kind: 'term',
    term: 'Order',
    definition: 'A request to purchase.',
    avoid: ['Purchase', 'transaction'],
    name: 'Ordering',
    description: 'Receives and tracks customer orders.',
  })
  check('grill_docs_update kind=term writes CONTEXT.md at the workspace root',
    termWritten.kind === 'term' && termWritten.path === join(docsWorkspace, 'CONTEXT.md'))
  const contextAfter = await readFile(join(docsWorkspace, 'CONTEXT.md'), 'utf8')
  check('CONTEXT.md follows the CONTEXT-FORMAT', contextAfter.includes('# Ordering') && contextAfter.includes('**Order**:') && contextAfter.includes('_Avoid_: Purchase, transaction'))

  const readAfterTerm = await callDocs('grill_docs_read', { session_id: 'docs-flow', scope: 'context' })
  check('grill_docs_read scope=context returns the glossary', readAfterTerm.context?.includes('**Order**:') === true)

  const adrWritten = await callDocs('grill_docs_update', {
    session_id: 'docs-flow',
    kind: 'adr',
    title: 'Use Postgres for the write model',
    body: 'The write model is event-sourced and projected into Postgres.',
    status: 'accepted',
    considered: ['MySQL', 'MongoDB'],
  })
  check('grill_docs_update kind=adr writes 0001-slug.md', adrWritten.kind === 'adr' && adrWritten.number === 1 && adrWritten.path.endsWith('0001-use-postgres-for-the-write-model.md'))
  const readAdrs = await callDocs('grill_docs_read', { session_id: 'docs-flow', scope: 'adr' })
  check('grill_docs_read scope=adr reports the ADR and next number', readAdrs.adrs.length === 1 && readAdrs.adrs[0]?.startsWith('0001-') && readAdrs.next_adr === 2)

  const secondAdr = await callDocs('grill_docs_update', {
    session_id: 'docs-flow',
    kind: 'adr',
    title: 'Manual SQL over ORM',
    body: 'Manual SQL because the query shapes are too unusual for an ORM.',
  })
  check('second ADR increments the number', secondAdr.number === 2 && secondAdr.path.endsWith('0002-manual-sql-over-orm.md'))
  check('docs-updated events emitted', events.filter(event => event.type === 'plugin:grill-me/docs-updated').length === 3)

  await rejectedDocs('grill_docs_update', { session_id: 'missing', kind: 'term', term: 'X', definition: 'Y' }, 'grill_docs_update on an unknown session is rejected')
  await rejectedDocs('grill_docs_update', { session_id: 'docs-flow', kind: 'term', term: 'X' }, 'grill_docs_update term without a definition is rejected')
  await rejectedDocs('grill_docs_update', { session_id: 'docs-flow', kind: 'adr', title: 'X' }, 'grill_docs_update adr without a body is rejected')
  await rejectedDocs('grill_docs_update', { session_id: 'docs-flow', kind: 'bogus' }, 'grill_docs_update with an unknown kind is rejected')
} finally {
  await rm(docsWorkspace, { recursive: true, force: true })
}

// --- /grill-me host command ---

/** Stub cordis context whose `inject` child activates only when `commands` exists. */
function commandHarness(hasCommands = true) {
  const registered = new Map()
  const registerDisposers = []
  const ctx = {
    inject(names, setup) {
      if (!hasCommands || !names.includes('commands')) return () => {}
      // Cordis disposes an inject child by disposing every effect registered
      // on it; the commands.register disposer is the cleanup the child runs.
      return setup(ctx)
    },
    commands: hasCommands
      ? {
          register(definition) {
            if (registered.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
            registered.set(definition.name, definition)
            const disposer = () => registered.delete(definition.name)
            registerDisposers.push(disposer)
            return disposer
          },
        }
      : undefined,
  }
  return { ctx, registered, registerDisposers }
}

function agentWithSteer() {
  const steered = []
  return {
    agent: { steer(message) { steered.push(message) } },
    steered,
  }
}

console.log('\n/grill-me command verification')
{
  const { ctx, registered, registerDisposers } = commandHarness(true)
  registerGrillCommand(ctx)
  check('command registers when commands is composed', registered.size === 1 && registered.has(GRILL_COMMAND))
  const definition = registered.get(GRILL_COMMAND)
  check('command exposes discovery metadata',
    definition?.name === 'grill-me'
    && typeof definition?.description === 'string' && definition.description.length > 0
    && definition?.input?.hint === '[query]')
  check('grillLine rebuilds the literal line',
    grillLine('  帮我做X') === '/grill-me  帮我做X' && grillLine('') === '/grill-me')

  const withQuery = agentWithSteer()
  const queryResult = definition.handler({ agent: withQuery.agent, rawInput: '  帮我做X' })
  check('with-query invocation returns success',
    queryResult.kind === 'success' && queryResult.text === 'Grilling: 帮我做X')
  check('handler steers the literal command line',
    withQuery.steered.length === 1
    && withQuery.steered[0].content?.[0]?.text === '/grill-me  帮我做X'
    && withQuery.steered[0].source?.kind === 'user')

  const bare = agentWithSteer()
  const bareResult = definition.handler({ agent: bare.agent, rawInput: '' })
  check('bare invocation returns success',
    bareResult.kind === 'success' && bareResult.text === 'Grilling your latest request.')
  check('bare handler steers the bare command line',
    bare.steered.length === 1 && bare.steered[0].content?.[0]?.text === '/grill-me')

  const noSteer = definition.handler({ agent: {}, rawInput: 'x' })
  check('handler without an agent steer channel returns an error',
    noSteer.kind === 'error' && typeof noSteer.text === 'string' && noSteer.text.length > 0)

  registerDisposers[0]?.()
  check('disposing the command child unregisters it', registered.size === 0)

  const absent = commandHarness(false)
  registerGrillCommand(absent.ctx)
  check('command stays unregistered without a commands service', absent.registered.size === 0)
}

console.log('\n/grill-with-docs command verification')
{
  const { ctx, registered, registerDisposers } = commandHarness(true)
  registerGrillDocsCommand(ctx)
  check('docs command registers alongside grill-me', registered.size === 1 && registered.has(GRILL_DOCS_COMMAND))
  const definition = registered.get(GRILL_DOCS_COMMAND)
  check('docs command exposes discovery metadata',
    definition?.name === 'grill-with-docs'
    && typeof definition?.description === 'string' && definition.description.length > 0
    && definition?.input?.hint === '[query]')
  check('grillDocsLine rebuilds the literal line',
    grillDocsLine('  帮我做X') === '/grill-with-docs  帮我做X' && grillDocsLine('') === '/grill-with-docs')

  const withQuery = agentWithSteer()
  const queryResult = definition.handler({ agent: withQuery.agent, rawInput: '  帮我做X' })
  check('with-query invocation returns success',
    queryResult.kind === 'success' && queryResult.text === 'Grilling with docs: 帮我做X')
  check('handler steers the literal docs command line',
    withQuery.steered.length === 1
    && withQuery.steered[0].content?.[0]?.text === '/grill-with-docs  帮我做X'
    && withQuery.steered[0].source?.kind === 'user')

  const bare = agentWithSteer()
  const bareResult = definition.handler({ agent: bare.agent, rawInput: '' })
  check('bare invocation returns success',
    bareResult.kind === 'success' && bareResult.text === 'Grilling your latest request with docs.')
  check('bare handler steers the bare docs command line',
    bare.steered.length === 1 && bare.steered[0].content?.[0]?.text === '/grill-with-docs')

  const noSteer = definition.handler({ agent: {}, rawInput: 'x' })
  check('handler without an agent steer channel returns an error',
    noSteer.kind === 'error' && typeof noSteer.text === 'string' && noSteer.text.length > 0)

  registerDisposers[0]?.()
  check('disposing the docs command child unregisters it', registered.size === 0)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nlifecycle checks passed')