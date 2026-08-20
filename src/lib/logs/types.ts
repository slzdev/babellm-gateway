import type { LoggingSettings } from '@/lib/settings'

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
  /** The v7 uuid minted at request start. Primary key, x-request-id, and the
   * partition key — one value for the request's whole life. */
  id: string
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
  /** Caller-supplied tags from the x-babellm-tags header. Absent or null both
   * mean "no tags"; the store writes SQL NULL for either. */
  tags?: Record<string, string> | null
  payload?: LogPayload | null
}

export interface MaintenanceResult {
  /** Partition names created and dropped, for the Settings status line.
   * Names rather than a row count: dropping a partition never counts the rows
   * inside it, and a number that was sometimes real and sometimes a guess
   * would be worse than no number. */
  created: string[]
  dropped: string[]
}

interface BaseSink {
  readonly name: string
  write(entry: RequestLogEntry): Promise<void>
  /** Provision storage ahead of time and discard what has aged out. A driver
   * with no storage of its own returns empty arrays. */
  maintain(now: Date, settings: LoggingSettings): Promise<MaintenanceResult>
  /** Drain anything buffered. Called on shutdown. */
  flush?(): Promise<void>
}

/** A sink that swallows entries and cannot hand them back — a log shipper, a
 * message queue, an append-only file. The gateway ships no such driver today;
 * this is the contract one would implement, and the reason `/logs` still has
 * a "cannot be read back" state to fall into. */
export interface WriteOnlySink extends BaseSink {
  readonly readable: false
}

export interface ReadableRequestLogStore extends BaseSink {
  readonly readable: true
  query(filter: LogFilter): Promise<LogPage>
  /** By primary key. Returns null for anything that is not a uuid. */
  get(id: string): Promise<LogDetail | null>
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
  tags: Record<string, string> | null
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
