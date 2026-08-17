#!/usr/bin/env node
/**
 * Drives the compiled grill_* tools through one full lifecycle:
 * begin -> question -> blocked prereq -> answer -> settle -> archive,
 * then verifies the /grill-me host command registration and steering.
 * Requires a prior `pnpm build` (lib/ present).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { GRILL_COMMAND, grillLine, registerGrillCommand } from '../lib/command.js'
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
registerGrillTools(ctx, { stateDir: '.grill-me' })

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
  check('session-created event emitted', events.some(event => event.type === 'grill-me/session-created'))
  check('decision-answered events emitted', events.filter(event => event.type === 'grill-me/decision-answered').length === 2)
  check('session-settled event emitted', events.some(event => event.type === 'grill-me/session-settled'))
  check('session-archived event emitted', events.some(event => event.type === 'grill-me/session-archived'))
} finally {
  await rm(workspace, { recursive: true, force: true })
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

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nlifecycle checks passed')