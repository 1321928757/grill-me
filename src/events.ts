import * as sessionModule from '@deepseek-ai/dsh-session'
import type { GrillEventData, GrillEventType } from './event-types.ts'

/** Structural slice of the calling agent used for event emission. */
export interface EventHostAgent {
  /** The calling agent's session, when the host composed one. */
  session?: unknown
}

/**
 * The two runtime pieces this plugin needs from `@deepseek-ai/dsh-session`.
 *
 * Read through the module namespace and feature-detected on purpose: a DSH
 * 0.1.x host resolves the same specifier to a build without
 * `appendPluginRecord`, and a missing named export would fail module linking
 * and take the whole plugin down with it. Audit records are advisory, so a
 * host that cannot take them must lose records, not the plugin.
 */
const sessionApi = sessionModule as unknown as {
  readonly Session?: unknown
  readonly appendPluginRecord?: (session: unknown, type: string, data: unknown) => unknown
}

/**
 * Append one grill-me audit record to the calling agent's session log.
 *
 * The design tree on disk (`<workspace>/<stateDir>/<sessionId>/session.json`)
 * is the source of truth; these records are an advisory audit trail, so every
 * failure is swallowed instead of failing the tool call.
 */
export function appendGrillEvent<K extends GrillEventType>(
  agent: EventHostAgent | undefined,
  type: K,
  data: GrillEventData<K>,
): void {
  const session = agent?.session
  if (session === undefined) return

  const SessionClass = sessionApi.Session as (new () => object) | undefined
  const appendRecord = sessionApi.appendPluginRecord
  if (typeof SessionClass === 'function' && typeof appendRecord === 'function' && session instanceof SessionClass) {
    try {
      // The sanctioned path: a `plugin:`-namespaced record that the runtime
      // commits as `ignorable: true`, outside `SessionEventMap`.
      appendRecord(session, type, data)
    } catch {
      // Advisory only; the frozen tree on disk stays authoritative.
    }
    return
  }

  // Older host, or a stubbed session from the offline verify harnesses: fall
  // back to the untyped append so the record still reaches whatever log is
  // attached, without claiming the runtime record guarantees.
  const append = (session as { append?: unknown }).append
  if (typeof append !== 'function') return
  try {
    (append as (eventType: string, payload: unknown) => void).call(session, type, data)
  } catch {
    // Same policy as above.
  }
}
