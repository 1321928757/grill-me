export type GrillStatus = 'open' | 'settled' | 'archived'

export interface GrillDecision {
  id: string
  question: string
  recommendation: string
  prerequisites: string[]
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