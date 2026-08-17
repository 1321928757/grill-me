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
import { readSession } from '../lib/state.js'

const workspace = await mkdtemp(join(tmpdir(), 'dsh-grill-me-stress-'))
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

const exec = { agent: { session: { header: { cwd: workspace }, append() {} } } }

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
} finally {
  await rm(workspace, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nstress checks passed')