import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { appendGrillEvent } from './events.ts'
import { readSession, sanitizeKey, withSessionLock } from './state.ts'
import type { GrillSession } from './types.ts'

export interface DocsToolsConfig {
  stateDir: string
  /** Docs root relative to the caller workspace; '' means the workspace root. */
  docsDir: string
  /** Whether /grill-with-docs sessions may write docs. */
  docsEnabled: boolean
}

/** Structural slice of the tool execution context we read; the rest is framework-owned. */
interface DocsExecContext {
  agent?: Agent
  signal: AbortSignal
}

function requireSession(session: GrillSession | undefined, sessionId: string): GrillSession {
  if (!session) throw new Error(`unknown grill session "${sessionId}"`)
  return session
}

function workspaceOf(exec: DocsExecContext): string {
  const workspace = exec.agent?.session.header.cwd
  if (!workspace) throw new Error('grill-me: caller has no workspace')
  return workspace
}

/** See `render` in tools.ts: DSH calls `output.render(args, value)`. */
function render(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

// --- pure rules (unit-tested by verify.mjs) ---

/** Fold an ADR title into a file-name slug. */
export function adrSlug(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') return 'decision'
  return sanitizeKey(trimmed)
}

/** Next sequential ADR number: max existing `NNNN-` prefix + 1. */
export function nextAdrNumber(entries: string[]): number {
  let max = 0
  for (const entry of entries) {
    const match = /^(\d{4})-/.exec(entry)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

/** `0001-slug.md` from a number and title. */
export function adrFileName(number: number, title: string): string {
  return `${String(number).padStart(4, '0')}-${adrSlug(title)}.md`
}

/** Render one ADR file body: 1-3 sentence summary + optional sections. */
export function renderAdr(title: string, body: string, options: {
  status?: string
  considered?: string[]
  consequences?: string
} = {}): string {
  const lines: string[] = []
  const frontmatter: string[] = []
  if (options.status !== undefined) frontmatter.push(`status: ${options.status.trim()}`)
  if (frontmatter.length > 0) {
    lines.push('---', ...frontmatter, '---', '')
  }
  lines.push(`# ${title.trim()}`, '')
  lines.push(body.trim(), '')
  if (options.considered !== undefined && options.considered.length > 0) {
    lines.push('## Considered Options', '')
    for (const option of options.considered) lines.push(`- ${option.trim()}`)
    lines.push('')
  }
  if (options.consequences !== undefined && options.consequences.trim() !== '') {
    lines.push('## Consequences', '')
    lines.push(options.consequences.trim(), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Detect the context layout from the docs-root file list. */
export function detectLayout(files: string[]): 'single' | 'multi' {
  return files.includes('CONTEXT-MAP.md') ? 'multi' : 'single'
}

export interface TermEntry {
  term: string
  definition: string
  avoid: string[]
  /** Optional grouping subheading inside `## Language`. */
  section?: string
}

export interface ContextMeta {
  name?: string
  description?: string
}

/** Render a fresh CONTEXT.md with the given terms. */
export function renderContext(meta: ContextMeta, terms: TermEntry[]): string {
  const lines: string[] = []
  lines.push(`# ${(meta.name ?? 'Context').trim()}`, '')
  if (meta.description !== undefined && meta.description.trim() !== '') {
    lines.push(meta.description.trim(), '')
  }
  lines.push('## Language', '')
  const groups = groupTerms(terms)
  for (const [section, entries] of groups) {
    if (section !== null) {
      lines.push(`### ${section}`, '')
    }
    for (const entry of entries) {
      lines.push(`**${entry.term.trim()}**:`, `${entry.definition.trim()}`, '')
      if (entry.avoid.length > 0) {
        lines.push(`_Avoid_: ${entry.avoid.map(item => item.trim()).join(', ')}`, '')
      }
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Group terms by their optional section; `null` groups come first. */
export function groupTerms(terms: TermEntry[]): [string | null, TermEntry[]][] {
  const groups = new Map<string | null, TermEntry[]>()
  for (const entry of terms) {
    const key = entry.section?.trim() || null
    const bucket = groups.get(key) ?? []
    bucket.push(entry)
    groups.set(key, bucket)
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === null) return -1
    if (b[0] === null) return 1
    return a[0]!.localeCompare(b[0]!)
  })
}

/** Escape a term so it matches only inside `**term**:` labels. */
function termPattern(term: string): RegExp {
  // JS has no `\z` anchor; `(?![\s\S])` asserts the true string end (the `$`
  // with the `m` flag would match every line end and stop the match early).
  // Note the doubled backslashes: in a template literal `\s` would collapse
  // to `s`, turning the negative lookahead into `(?![sS])`.
  return new RegExp(`^\\*\\*${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*:[\\s\\S]*?(?=^\\*\\*|^### |^## |(?![\\s\\S]))`, 'm')
}

/**
 * Upsert one term into an existing CONTEXT.md (or undefined for a fresh one).
 * The `## Language` section is the only part rewritten; headers and any other
 * sections survive untouched.
 */
export function upsertTerm(contextText: string | undefined, entry: TermEntry, meta: ContextMeta = {}): string {
  if (contextText === undefined || contextText.trim() === '') {
    return renderContext(meta, [entry])
  }
  const languageIndex = contextText.indexOf('## Language')
  if (languageIndex === -1) {
    // No Language section yet: append it after the existing content.
    return `${contextText.trimEnd()}\n\n## Language\n\n${renderTermBlock(entry)}`
  }
  const head = contextText.slice(0, languageIndex)
  const language = contextText.slice(languageIndex + '## Language'.length)
  const pattern = termPattern(entry.term)
  let updatedLanguage: string
  if (pattern.test(language)) {
    updatedLanguage = language.replace(pattern, renderTermBlock(entry).trimEnd())
  } else {
    updatedLanguage = `${language.trimEnd()}\n\n${renderTermBlock(entry)}`
  }
  return `${head}## Language${updatedLanguage}`
}

function renderTermBlock(entry: TermEntry): string {
  const lines = [`**${entry.term.trim()}**:`, `${entry.definition.trim()}`, '']
  if (entry.avoid.length > 0) {
    lines.push(`_Avoid_: ${entry.avoid.map(item => item.trim()).join(', ')}`, '')
  }
  return lines.join('\n')
}

// --- tool registration ---

export function registerGrillDocsTools(ctx: Context, config: DocsToolsConfig): void {
  const stateRootOf = (exec: DocsExecContext) => join(workspaceOf(exec), config.stateDir)
  const docsRootOf = (exec: DocsExecContext) => join(workspaceOf(exec), config.docsDir)

  ctx.tools.register(defineTool({
    name: 'grill_docs_read',
    description: 'Read the current domain-modeling docs (CONTEXT.md glossary, CONTEXT-MAP.md, docs/adr/ decisions) for a grill session, so terms and decision numbers are never guessed or duplicated.',
    parameters: {
      session_id: { type: 'string', required: true },
      scope: { type: 'string', description: 'Which docs to read: context | adr | map | all (default).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          layout: { type: 'string', required: true },
          docs_root: { type: 'string', required: true },
          context: { type: 'string' },
          map: { type: 'string' },
          adrs: { type: 'array', required: true },
          next_adr: { type: 'integer', required: true },
        },
      },
      render,
    },
    async execute(args: { session_id: string; scope?: string }, exec: DocsExecContext) {
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${args.session_id}`, async () => {
        const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
        const docsRoot = docsRootOf(exec)
        const scope = args.scope ?? 'all'
        const result: {
          session_id: string
          status: string
          layout: 'single' | 'multi'
          docs_root: string
          context?: string
          map?: string
          adrs: string[]
          next_adr: number
        } = {
          session_id: session.id,
          status: session.status,
          layout: 'single',
          docs_root: docsRoot,
          adrs: [],
          next_adr: 1,
        }
        let rootFiles: string[] = []
        try {
          rootFiles = await readdir(docsRoot)
        } catch {
          rootFiles = [] // lazy creation: nothing exists yet
        }
        result.layout = detectLayout(rootFiles)
        if (scope === 'context' || scope === 'all') {
          const contextPath = join(docsRoot, 'CONTEXT.md')
          try {
            result.context = await readFile(contextPath, 'utf8')
          } catch {
            // absent: first term will create it lazily
          }
        }
        if (scope === 'map' || scope === 'all') {
          const mapPath = join(docsRoot, 'CONTEXT-MAP.md')
          try {
            result.map = await readFile(mapPath, 'utf8')
          } catch {
            // absent: single-context layout
          }
        }
        if (scope === 'adr' || scope === 'all') {
          const adrDir = join(docsRoot, 'docs', 'adr')
          try {
            result.adrs = (await readdir(adrDir)).filter(name => /^\d{4}-.*\.md$/.test(name)).sort()
          } catch {
            result.adrs = []
          }
          result.next_adr = nextAdrNumber(result.adrs)
        }
        return result
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grill_docs_update',
    description: 'Write one domain-modeling artifact during a grill session: a CONTEXT.md glossary term (kind=term) or an ADR in docs/adr/ (kind=adr). Follows CONTEXT-FORMAT / ADR-FORMAT; the disk is the source of truth.',
    parameters: {
      session_id: { type: 'string', required: true },
      kind: { type: 'string', required: true, description: 'term | adr' },
      context: { type: 'string', description: 'Target context path under the docs root (e.g. "src/ordering"); omit for the root context.' },
      term: { type: 'string', description: 'kind=term: the canonical term name.' },
      definition: { type: 'string', description: 'kind=term: one or two sentence definition (what it IS).' },
      avoid: { type: 'array', items: { type: 'string' }, description: 'kind=term: terms to avoid for this concept.' },
      section: { type: 'string', description: 'kind=term: optional grouping subheading inside ## Language.' },
      name: { type: 'string', description: 'kind=term, fresh file only: the context name for a new CONTEXT.md.' },
      description: { type: 'string', description: 'kind=term, fresh file only: the context description for a new CONTEXT.md.' },
      title: { type: 'string', description: 'kind=adr: the decision title (drives the 000N-slug file name).' },
      body: { type: 'string', description: 'kind=adr: 1-3 sentence summary (context, decision, why).' },
      status: { type: 'string', description: 'kind=adr: optional frontmatter status.' },
      considered: { type: 'array', items: { type: 'string' }, description: 'kind=adr: optional rejected alternatives.' },
      consequences: { type: 'string', description: 'kind=adr: optional non-obvious consequences.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          path: { type: 'string', required: true },
          number: { type: 'integer' },
        },
      },
      render,
    },
    async execute(args: {
      session_id: string
      kind: string
      context?: string
      term?: string
      definition?: string
      avoid?: string[]
      section?: string
      name?: string
      description?: string
      title?: string
      body?: string
      status?: string
      considered?: string[]
      consequences?: string
    }, exec: DocsExecContext) {
      const stateRoot = stateRootOf(exec)
      return withSessionLock(`${stateRoot}\u0000${args.session_id}`, async () => {
        const session = requireSession(await readSession(stateRoot, args.session_id), args.session_id)
        if (session.status !== 'open') throw new Error(`session is ${session.status}; docs update requires an open session`)
        if (!config.docsEnabled) throw new Error('grill-with-docs is disabled (docsEnabled: false); /grill-me never writes docs')
        const docsRoot = docsRootOf(exec)
        const targetRoot = args.context !== undefined && args.context.trim() !== ''
          ? join(docsRoot, args.context.trim())
          : docsRoot
        if (args.kind === 'term') {
          const term = (args.term ?? '').trim()
          if (term === '') throw new Error('grill_docs_update kind=term requires a term')
          const definition = (args.definition ?? '').trim()
          if (definition === '') throw new Error('grill_docs_update kind=term requires a definition')
          const contextPath = join(targetRoot, 'CONTEXT.md')
          let existing: string | undefined
          try {
            existing = await readFile(contextPath, 'utf8')
          } catch {
            existing = undefined
          }
          const updated = upsertTerm(existing, {
            term,
            definition,
            avoid: args.avoid ?? [],
            section: args.section,
          }, { name: args.name, description: args.description })
          await mkdir(targetRoot, { recursive: true })
          await writeFile(contextPath, updated, 'utf8')
          appendGrillEvent(exec.agent, 'plugin:grill-me/docs-updated', {
            sessionId: session.id,
            kind: 'term',
            path: contextPath,
            scope: args.context?.trim() ?? '',
          })
          return { session_id: session.id, kind: 'term', path: contextPath }
        }
        if (args.kind === 'adr') {
          const title = (args.title ?? '').trim()
          if (title === '') throw new Error('grill_docs_update kind=adr requires a title')
          const body = (args.body ?? '').trim()
          if (body === '') throw new Error('grill_docs_update kind=adr requires a body')
          const adrDir = join(targetRoot, 'docs', 'adr')
          let entries: string[] = []
          try {
            entries = (await readdir(adrDir)).filter(name => /^\d{4}-.*\.md$/.test(name))
          } catch {
            entries = []
          }
          const number = nextAdrNumber(entries)
          const fileName = adrFileName(number, title)
          await mkdir(adrDir, { recursive: true })
          await writeFile(join(adrDir, fileName), renderAdr(title, body, {
            status: args.status,
            considered: args.considered,
            consequences: args.consequences,
          }), 'utf8')
          appendGrillEvent(exec.agent, 'plugin:grill-me/docs-updated', {
            sessionId: session.id,
            kind: 'adr',
            path: join(adrDir, fileName),
            scope: args.context?.trim() ?? '',
          })
          return { session_id: session.id, kind: 'adr', path: join(adrDir, fileName), number }
        }
        throw new Error(`grill_docs_update kind must be "term" or "adr", got ${args.kind}`)
      })
    },
  }))
}
