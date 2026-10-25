export interface GrillSessionCreatedData {
  readonly sessionId: string
  readonly query: string
}

export interface GrillDecisionAnsweredData {
  readonly sessionId: string
  readonly questionId: string
  readonly answer: string
}

export interface GrillFrontierAskedData {
  readonly sessionId: string
  readonly answers: readonly { readonly questionId: string; readonly answer: string }[]
  readonly remaining: number
}

export interface GrillSessionSettledData {
  readonly sessionId: string
  readonly boundary: string
}

export interface GrillSessionArchivedData {
  readonly sessionId: string
  readonly reason?: string
}

export interface GrillDocsUpdatedData {
  readonly sessionId: string
  readonly kind: 'term' | 'adr'
  readonly path: string
  readonly scope: string
}

/**
 * The audit records this plugin writes.
 *
 * Since DSH 0.2.0 an out-of-tree plugin no longer declares its records on
 * `SessionEventMap`: released session events are owned by the harness, and the
 * reserved external namespace is the `plugin:` record grammar. Names therefore
 * read `plugin:<owner>/<record>` and the payloads live on `PluginRecordMap`,
 * which keeps them out of the released persistence schemas while a build that
 * does not know them retains and skips them (`ignorable: true`).
 */
export interface GrillEventMap {
  'plugin:grill-me/session-created': GrillSessionCreatedData
  'plugin:grill-me/decision-answered': GrillDecisionAnsweredData
  'plugin:grill-me/frontier-asked': GrillFrontierAskedData
  'plugin:grill-me/session-settled': GrillSessionSettledData
  'plugin:grill-me/session-archived': GrillSessionArchivedData
  'plugin:grill-me/docs-updated': GrillDocsUpdatedData
}

/** One record name this plugin may append. */
export type GrillEventType = keyof GrillEventMap

/** Payload of one record name. */
export type GrillEventData<K extends GrillEventType> = GrillEventMap[K]

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap extends GrillEventMap {}
}
