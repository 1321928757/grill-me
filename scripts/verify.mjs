#!/usr/bin/env node
/**
 * Offline smoke verification for dsh-grill-me.
 *
 * Runs the pure design-tree rules and the on-disk session flow against
 * throwaway temp state. Requires a prior `pnpm build` (lib/ present).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addDecision,
  answerDecision,
  archiveSession,
  archiveStatus,
  createSession,
  frontierOf,
  normalizeOptions,
  prereqBlockers,
  readSession,
  sanitizeKey,
  settleSession,
  writeSession,
} from '../lib/state.js'
import {
  adrFileName,
  adrSlug,
  detectLayout,
  groupTerms,
  nextAdrNumber,
  renderAdr,
  renderContext,
  upsertTerm,
} from '../lib/docs.js'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('dsh-grill-me offline verification')

console.log('1/3 packaging contract')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const patchName = patchText
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .find(line => /^\s*name:\s*\S/.test(line))
  ?.split(':')
  .slice(1)
  .join(':')
  .trim()
  .replace(/^(['"])(.*)\1$/, '$2')
check('cordis.patch.yml name matches the published package name', patchName === pkg.name, `patch has ${JSON.stringify(patchName)}`)
check('scoped patch name is quoted in YAML', !patchName.startsWith('@') || /name:\s*["']@/.test(patchText), 'a plain @-prefixed YAML scalar is invalid')
check('files[] ships the bundle patch and lib', ['lib', 'cordis.patch.yml'].every(entry => pkg.files?.includes(entry)))
check('scoped package publishes publicly', !pkg.name.startsWith('@') || pkg.publishConfig?.access === 'public')
const requiredPeers = Object.keys(pkg.peerDependencies ?? {}).filter(name => pkg.peerDependenciesMeta?.[name]?.optional !== true)
check('shared runtime peers are optional for standalone profile installs', requiredPeers.length === 0, `required: ${JSON.stringify(requiredPeers)}`)

console.log('2/3 pure design-tree rules')
const baseSession = {
  id: 'demo',
  query: 'Build a trading bot',
  status: 'open',
  decisions: [],
  createdAt: 0,
  updatedAt: 0,
}
check("sanitizeKey('Build a Trading Bot!') -> 'build-a-trading-bot'", sanitizeKey('Build a Trading Bot!') === 'build-a-trading-bot')
check('CJK names stay distinct', sanitizeKey('研究员') !== sanitizeKey('工程师'))
check('sanitizeKey never escapes the path segment', !/[\\/:*?"<>|]/.test(sanitizeKey('a/b\\c:d*e?f"g<h>i|j')) && !sanitizeKey('../../etc').includes('.'))

let session = addDecision(baseSession, { id: 'scope', question: 'Which scope?', recommendation: 'MVP only', prerequisites: [] })
check('first decision enters the frontier', frontierOf(session).length === 1 && frontierOf(session)[0]?.id === 'scope')
let blocked = false
try {
  addDecision(session, { id: 'market', question: 'Which market?', recommendation: 'US', prerequisites: ['scope'] })
} catch {
  blocked = true
}
check('question with an unsettled prerequisite is rejected', blocked)

session = answerDecision(session, 'scope', 'MVP only')
session = addDecision(session, { id: 'market', question: 'Which market?', recommendation: 'US', prerequisites: ['scope'] })
check('answered prerequisite unlocks the next decision', frontierOf(session).map(decision => decision.id).join(',') === 'market')
check('prereq blockers name the open prerequisite', prereqBlockers(session, 'market').join(',') === '')

let frozen = false
try {
  answerDecision(session, 'scope', 'another answer')
} catch {
  frozen = true
}
check('answered decisions are frozen', frozen)

session = answerDecision(session, 'market', 'US')
check('empty frontier is ready to settle', frontierOf(session).length === 0)

const multi = addDecision(session, {
  id: 'delivery',
  question: 'Which delivery?',
  recommendation: 'Cloud',
  prerequisites: [],
  options: ['Cloud', 'On-prem', 'Hybrid'],
})
check('multi-option decision enters the frontier with its options',
  frontierOf(multi).length === 1 && JSON.stringify(frontierOf(multi)[0]?.options) === JSON.stringify(['Cloud', 'On-prem', 'Hybrid']))
check('normalizeOptions keeps 2-4 trimmed choices', JSON.stringify(normalizeOptions('Cloud', [' Cloud ', 'On-prem', 'Hybrid'])) === JSON.stringify(['Cloud', 'On-prem', 'Hybrid']))
let optionsRejected = false
try {
  normalizeOptions('Cloud', ['Cloud'])
} catch {
  optionsRejected = true
}
check('fewer than 2 options are rejected', optionsRejected)
optionsRejected = false
try {
  normalizeOptions('Cloud', ['A', 'B', 'C', 'D', 'E'])
} catch {
  optionsRejected = true
}
check('more than 4 options are rejected', optionsRejected)
optionsRejected = false
try {
  normalizeOptions('Cloud', ['On-prem', 'Hybrid'])
} catch {
  optionsRejected = true
}
check('options whose first entry is not the recommendation are rejected', optionsRejected)
let multiFrozen = false
try {
  answerDecision(session, 'delivery', 'Cloud')
} catch {
  multiFrozen = true
}
check('answering a decision absent from the session is rejected', multiFrozen)
let settleRejected = false
try {
  settleSession(session, ' ')
} catch {
  settleRejected = true
}
check('empty boundary is rejected', settleRejected)
session = settleSession(session, 'MVP for US users only')
check('settle freezes the boundary', session.status === 'settled' && session.boundary === 'MVP for US users only')
const archived = archiveStatus(session)
check('archive keeps the full tree', archived.status === 'archived' && archived.decisions.length === 2)

console.log('2b/3 grill-with-docs pure rules')
check('adrSlug folds a title into a file slug', adrSlug('Use Postgres for the write model') === 'use-postgres-for-the-write-model')
check('adrSlug falls back for an empty title', adrSlug('   ') === 'decision')
check('nextAdrNumber starts at 1 with no entries', nextAdrNumber([]) === 1)
check('nextAdrNumber skips non-ADR files', nextAdrNumber(['README.md', 'notes.txt']) === 1)
check('nextAdrNumber increments past the highest', nextAdrNumber(['0001-x.md', '0003-y.md', '0002-z.md']) === 4)
check('adrFileName pads and slugs', adrFileName(3, 'Event-Sourced Orders!') === '0003-event-sourced-orders.md')
const adr = renderAdr('Use Postgres', 'The write model is projected into Postgres.', { status: 'accepted', considered: ['MySQL', 'MongoDB'] })
check('renderAdr writes the title and body', adr.includes('# Use Postgres') && adr.includes('The write model is projected into Postgres.'))
check('renderAdr includes optional frontmatter', adr.includes('status: accepted'))
check('renderAdr lists considered options', adr.includes('- MySQL') && adr.includes('- MongoDB'))
check('renderAdr omits empty sections', !renderAdr('X', 'Y').includes('Considered Options'))
check('detectLayout treats CONTEXT-MAP.md as multi', detectLayout(['CONTEXT-MAP.md', 'src/']) === 'multi')
check('detectLayout defaults to single', detectLayout(['CONTEXT.md', 'docs/']) === 'single')
const freshContext = renderContext({ name: 'Ordering', description: 'Receives and tracks customer orders.' }, [
  { term: 'Order', definition: 'A request to purchase.', avoid: ['Purchase', 'transaction'], section: null },
  { term: 'Customer', definition: 'A person who places orders.', avoid: [], section: 'Parties' },
])
check('renderContext writes the header', freshContext.startsWith('# Ordering\n\nReceives and tracks customer orders.'))
check('renderContext writes the Language section', freshContext.includes('## Language'))
check('renderContext writes _Avoid_ only when present', freshContext.includes('_Avoid_: Purchase, transaction') && !freshContext.includes('_Avoid_:\n'))
check('renderContext groups under subheadings', freshContext.includes('### Parties'))
check('groupTerms keeps null-section groups first', groupTerms([
  { term: 'B', definition: 'b', avoid: [], section: 'Z' },
  { term: 'A', definition: 'a', avoid: [], section: null },
])[0][0] === null)
let upserted = upsertTerm(undefined, { term: 'Order', definition: 'A request to purchase.', avoid: ['Purchase'] })
check('upsertTerm creates a fresh CONTEXT.md', upserted.includes('**Order**:') && upserted.includes('_Avoid_: Purchase'))
upserted = upsertTerm(freshContext, { term: 'Order', definition: 'A request to purchase goods.', avoid: ['Purchase', 'transaction', 'sale'] })
check('upsertTerm replaces an existing term definition', upserted.includes('A request to purchase goods.') && !upserted.includes('A request to purchase.'))
check('upsertTerm preserves other terms', upserted.includes('**Customer**:'))
const withLanguage = '# X\n\nIntro.\n\n## Language\n\n**Old**:\ndef.\n'
const appended = upsertTerm(withLanguage, { term: 'New', definition: 'nd.', avoid: [] })
check('upsertTerm appends to an existing Language section', appended.includes('**New**:') && appended.includes('**Old**:'))
const noLanguage = '# X\n\nJust an intro.\n'
const addedSection = upsertTerm(noLanguage, { term: 'New', definition: 'nd.', avoid: [] })
check('upsertTerm appends a Language section when missing', addedSection.includes('## Language') && addedSection.includes('**New**:'))

console.log('3/3 on-disk session flow (temp dir)')
const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-grill-me-verify-'))
try {
  await createSession(stateRoot, session)
  check('session.json round-trips', (await readSession(stateRoot, session.id))?.boundary === session.boundary)
  const reopened = await readSession(stateRoot, session.id)
  check('reopened session is settled', reopened?.status === 'settled')
  const updated = { ...session, query: 'Updated query' }
  await writeSession(stateRoot, updated)
  check('writeSession atomically updates', (await readSession(stateRoot, session.id))?.query === 'Updated query')
  await archiveSession(stateRoot, session.id)
  check('archive moves the session out of live reads', await readSession(stateRoot, session.id) === undefined)
  const archivedPath = join(stateRoot, 'archive', session.id, 'session.json')
  check('archive keeps the session.json', (await readFile(archivedPath, 'utf8')).includes('MVP for US users only'))
} finally {
  await rm(stateRoot, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')