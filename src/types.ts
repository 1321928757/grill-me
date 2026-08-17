export type GrillStatus = 'open' | 'settled' | 'archived'

export interface GrillDecision {
  id: string
  question: string
  recommendation: string
  prerequisites: string[]
  /** Optional 2-4 choices rendered as a multi-option card; the first must equal `recommendation` and carries the 推荐 badge. */
  options?: string[]
  answer?: string
  answeredAt?: number
}

export interface GrillSession {
  id: string
  query: string
  status: GrillStatus
  decisions: GrillDecision[]
  boundary?: string
  createdAt: number
  updatedAt: number
}