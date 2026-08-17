export interface GrillSessionCreatedData {
  readonly sessionId: string
  readonly query: string
}

export interface GrillDecisionAnsweredData {
  readonly sessionId: string
  readonly questionId: string
  readonly answer: string
}

export interface GrillSessionSettledData {
  readonly sessionId: string
  readonly boundary: string
}

export interface GrillSessionArchivedData {
  readonly sessionId: string
  readonly reason?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'grill-me/session-created': GrillSessionCreatedData
    'grill-me/decision-answered': GrillDecisionAnsweredData
    'grill-me/session-settled': GrillSessionSettledData
    'grill-me/session-archived': GrillSessionArchivedData
  }
}