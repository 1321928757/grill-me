import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'

/** Structural slice of the calling agent used for event emission. */
export interface EventHostAgent {
  session: {
    header?: unknown
    append?: unknown
  }
}

export function appendGrillEvent<K extends keyof SessionEventMap>(
  agent: EventHostAgent | undefined,
  type: K,
  data: SessionEventMap[K],
): void {
  const append = agent?.session.append
  if (typeof append !== 'function') return
  try {
    // The framework append is generic; this callable cast is the boundary adaptor.
    (append as (eventType: string, payload: unknown) => void)(type, data as unknown)
  } catch {
    // Event append is advisory; session.json and tool output remain the durable truth.
  }
}