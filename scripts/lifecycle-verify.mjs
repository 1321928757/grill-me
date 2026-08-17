#!/usr/bin/env node
/**
 * Drives the compiled grill_* tools through one full lifecycle:
 * begin -> question -> blocked prereq -> answer -> settle -> archive.
 * Requires a prior `pnpm build` (lib/ present).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerGrillTools } from '../lib/tools.js'
import { readSession } from '../lib/state.js'

const workspace = await mkdtemp(join(tmpdir(), 'dsh-grill-me-lifecycle-'))
const stateRoot = join(workspace, '.grill-me')
const definitions = new Map()

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
}
registerGrillTools(ctx, { stateDir: '.grill-me', maxRounds: 8 })

const events = []
const exec = {
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
  return definition.execute(args, exec)
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
  check('session-created event emitted', events.some(event => event.type === 'grill-me/session-created'))
  check('decision-answered events emitted', events.filter(event => event.type === 'grill-me/decision-answered').length === 2)
  check('session-settled event emitted', events.some(event => event.type === 'grill-me/session-settled'))
  check('session-archived event emitted', events.some(event => event.type === 'grill-me/session-archived'))
} finally {
  await rm(workspace, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nlifecycle checks passed')