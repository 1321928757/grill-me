import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GrillDecision, GrillSession, GrillStatus } from './types.ts'

/** Fold a query into a single safe path segment; distinct non-Latin names stay distinct. */
export function sanitizeKey(value: string): string {
  const folded = value.normalize('NFKC').trim().toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return folded || 'session'
}

export function answeredIds(session: GrillSession): Set<string> {
  return new Set(session.decisions.filter(decision => decision.answer !== undefined).map(decision => decision.id))
}

/** Decisions whose prerequisites are all settled and that are not answered yet. */
export function frontierOf(session: GrillSession): GrillDecision[] {
  if (session.status !== 'open') return []
  const answered = answeredIds(session)
  return session.decisions.filter(decision =>
    decision.answer === undefined && decision.prerequisites.every(prerequisite => answered.has(prerequisite)),
  )
}

/** Unsettled prerequisites that keep the decision off the frontier. */
export function prereqBlockers(session: GrillSession, decisionId: string): string[] {
  const answered = answeredIds(session)
  const decision = session.decisions.find(candidate => candidate.id === decisionId)
  return decision?.prerequisites.filter(prerequisite => !answered.has(prerequisite)) ?? []
}

/** Validate the optional multi-option list; returns the trimmed choices or undefined. */
export function normalizeOptions(recommendation: string, options: string[] | undefined): string[] | undefined {
  if (options === undefined) return undefined
  const cleaned = options.map(option => option.trim()).filter(option => option !== '')
  if (cleaned.length < 2 || cleaned.length > 4) {
    throw new Error(`decision options must have 2 to 4 choices, got ${options.length}`)
  }
  if (cleaned[0] !== recommendation.trim()) {
    throw new Error('the first option must be the recommended answer')
  }
  return cleaned
}

export function addDecision(
  session: GrillSession,
  input: Omit<GrillDecision, 'prerequisites' | 'answer' | 'answeredAt'> & { prerequisites?: string[] },
  now = Date.now(),
): GrillSession {
  if (session.status !== 'open') throw new Error(`session is ${session.status}; only open sessions accept questions`)
  const existing = session.decisions.find(decision => decision.id === input.id)
  if (existing?.answer !== undefined) throw new Error(`decision "${input.id}" is answered and frozen`)
  const prerequisites = input.prerequisites ?? []
  for (const prerequisite of prerequisites) {
    if (prerequisite === input.id) throw new Error(`decision "${input.id}" cannot depend on itself`)
    if (!session.decisions.some(decision => decision.id === prerequisite)) {
      throw new Error(`unknown prerequisite "${prerequisite}"`)
    }
  }
  const blockers = prerequisites.filter(prerequisite => !answeredIds(session).has(prerequisite))
  if (blockers.length > 0) throw new Error(`prerequisites not settled: ${blockers.join(', ')}`)
  const options = normalizeOptions(input.recommendation, input.options)
  const next: GrillDecision = {
    id: input.id,
    question: input.question,
    recommendation: input.recommendation,
    prerequisites,
    ...options !== undefined ? { options } : {},
  }
  const decisions = existing
    ? session.decisions.map(decision => decision.id === input.id ? next : decision)
    : [...session.decisions, next]
  return { ...session, decisions, updatedAt: now }
}

export function answerDecision(session: GrillSession, decisionId: string, answer: string, now = Date.now()): GrillSession {
  if (session.status !== 'open') throw new Error(`session is ${session.status}; answers are frozen`)
  const decision = session.decisions.find(candidate => candidate.id === decisionId)
  if (!decision) throw new Error(`unknown decision "${decisionId}"`)
  if (decision.answer !== undefined) throw new Error(`decision "${decisionId}" is already answered`)
  const blockers = prereqBlockers(session, decisionId)
  if (blockers.length > 0) throw new Error(`prerequisites not settled: ${blockers.join(', ')}`)
  const decisions = session.decisions.map(candidate => candidate.id === decisionId
    ? { ...candidate, answer, answeredAt: now }
    : candidate)
  return { ...session, decisions, updatedAt: now }
}

export function settleSession(session: GrillSession, boundary: string, now = Date.now()): GrillSession {
  if (session.status !== 'open') throw new Error(`session is ${session.status}; cannot settle`)
  if (frontierOf(session).length > 0) throw new Error('cannot settle with unanswered frontier questions')
  if (!boundary.trim()) throw new Error('settle requires a non-empty boundary spec')
  return { ...session, status: 'settled', boundary, updatedAt: now }
}

export function archiveStatus(session: GrillSession, now = Date.now()): GrillSession {
  if (session.status === 'archived') return session
  return { ...session, status: 'archived', updatedAt: now }
}

export function isGrillSession(value: unknown): value is GrillSession {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<GrillSession>
  return typeof candidate.id === 'string'
    && typeof candidate.query === 'string'
    && (candidate.status === 'open' || candidate.status === 'settled' || candidate.status === 'archived')
    && Array.isArray(candidate.decisions)
}

function sessionFile(stateRoot: string, id: string): string {
  return join(stateRoot, id, 'session.json')
}

const locks = new Map<string, Promise<unknown>>()

/** Serialize read-modify-write cycles for one session within this process. */
export function withSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  locks.set(key, previous.then(() => gate))
  return previous.then(async () => {
    try {
      return await operation()
    } finally {
      release()
    }
  })
}

export async function readSession(stateRoot: string, id: string): Promise<GrillSession | undefined> {
  try {
    const raw = await readFile(sessionFile(stateRoot, id), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isGrillSession(parsed)) throw new Error(`invalid session shape at ${sessionFile(stateRoot, id)}`)
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function createSession(stateRoot: string, session: GrillSession): Promise<void> {
  await mkdir(join(stateRoot, session.id), { recursive: true })
  await writeFile(sessionFile(stateRoot, session.id), `${JSON.stringify(session, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
}

export async function writeSession(stateRoot: string, session: GrillSession): Promise<void> {
  await mkdir(join(stateRoot, session.id), { recursive: true })
  const target = sessionFile(stateRoot, session.id)
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

export async function archiveSession(stateRoot: string, id: string): Promise<void> {
  const archivedRoot = join(stateRoot, 'archive')
  await mkdir(archivedRoot, { recursive: true })
  await rename(join(stateRoot, id), join(archivedRoot, id))
}