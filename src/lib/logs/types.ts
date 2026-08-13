export type RequestOutcome = 'ok' | 'error' | 'client_closed' | 'stream_interrupted'

export interface LoggedAttempt {
  n: number; targetId: string; provider: string; model: string
  status: number; latencyMs: number; error?: string
}
export interface LogUsage {
  promptTokens: number | null; completionTokens: number | null
  cachedTokens: number | null; reasoningTokens: number | null
}
export interface PricingSnapshot {
  inputPerMtok: string | null; cachedInputPerMtok: string | null; outputPerMtok: string | null
}
export interface CostBreakdown {
  inputUsd: string | null; cachedUsd: string | null
  outputUsd: string | null; totalUsd: string | null
  pricing: PricingSnapshot | null
}
export interface LogPayload { request: unknown; response: unknown; truncated: boolean }
export interface FinalTarget {
  targetId: string; providerId: string; provider: string; upstreamModel: string
}
export interface RequestLogEntry {
  requestId: string
  keyId: string | null
  keyName: string | null
  model: string | null
  stream: boolean
  status: number
  outcome: RequestOutcome
  errorType?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  latencyMs: number
  ttftMs?: number
  attempts: LoggedAttempt[]
  final?: FinalTarget | null
  usage?: LogUsage | null
  cost?: CostBreakdown | null
  droppedParams?: string[]
  payload?: LogPayload | null
}

interface BaseSink {
  readonly name: string
  write(entry: RequestLogEntry): Promise<void>
  /** Rows removed. A driver with no retention concept returns 0. */
  prune(olderThan: Date): Promise<number>
  /** Drain anything buffered. Called on shutdown. */
  flush?(): Promise<void>
}

export interface WriteOnlySink extends BaseSink {
  readonly readable: false
}

export interface ReadableRequestLogStore extends BaseSink {
  readonly readable: true
  query(filter: LogFilter): Promise<LogPage>
  get(requestId: string): Promise<LogDetail | null>
}

/**
 * A discriminated union rather than one interface with a boolean flag:
 * `if (store.readable)` narrows a union to its readable member, while a
 * boolean property on a single interface narrows nothing. That is what lets
 * the admin page branch on capability at compile time instead of calling a
 * query() that throws in production.
 */
export type RequestLogStore = WriteOnlySink | ReadableRequestLogStore

export type StatusClass = 'success' | 'client_error' | 'server_error'

export interface LogFilter {
  from?: Date
  to?: Date
  apiKeyId?: string
  model?: string
  statusClass?: StatusClass
  outcome?: RequestOutcome
  /** Keyset cursors — uuid v7 ids. `after` pages older, `before` pages newer. */
  after?: string
  before?: string
  limit: number
}

export interface LogRow {
  id: string
  requestId: string
  createdAt: Date
  keyName: string | null
  model: string | null
  stream: boolean
  status: number
  outcome: RequestOutcome
  latencyMs: number
  ttftMs: number | null
  finalProvider: string | null
  finalUpstreamModel: string | null
  promptTokens: number | null
  completionTokens: number | null
  costUsd: string | null
  payloadCaptured: boolean
}

export interface LogPage {
  rows: LogRow[]
  nextCursor: string | null
  prevCursor: string | null
}

export interface LogDetail extends LogRow {
  errorType: string | null
  errorCode: string | null
  errorMessage: string | null
  attempts: LoggedAttempt[]
  finalTargetId: string | null
  cachedTokens: number | null
  reasoningTokens: number | null
  inputCostUsd: string | null
  cachedCostUsd: string | null
  outputCostUsd: string | null
  pricing: PricingSnapshot | null
  droppedParams: string[] | null
  payload: LogPayload | null
}
