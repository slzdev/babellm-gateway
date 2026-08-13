import 'server-only'
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { requestLogs } from '@/lib/db/schema'
import { uuidv7Bound } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import { dropExpiredPartitions, ensurePartitions } from './partitions'
import type {
  LogDetail, LogFilter, LogPage, LogRow, MaintenanceResult, ReadableRequestLogStore,
  RequestLogEntry,
} from './types'

const MODEL_MAX_LENGTH = 128

/** Cursors and detail ids arrive from a URL. A non-uuid reaching a uuid
 * column comparison is an unhandled Postgres error, so it is rejected here
 * and read as "no such row". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An absurd model name in a request must not become a failed insert that
 * loses the log line. */
function clamp(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > MODEL_MAX_LENGTH ? value.slice(0, MODEL_MAX_LENGTH) : value
}

const LIST_COLUMNS = {
  id: requestLogs.id,
  createdAt: requestLogs.createdAt,
  keyName: requestLogs.keyName,
  model: requestLogs.model,
  stream: requestLogs.stream,
  status: requestLogs.status,
  outcome: requestLogs.outcome,
  latencyMs: requestLogs.latencyMs,
  ttftMs: requestLogs.ttftMs,
  finalProvider: requestLogs.finalProvider,
  finalUpstreamModel: requestLogs.finalUpstreamModel,
  promptTokens: requestLogs.promptTokens,
  completionTokens: requestLogs.completionTokens,
  costUsd: requestLogs.costUsd,
  payloadCaptured: requestLogs.payloadCaptured,
}

function conditions(filter: LogFilter) {
  const where = []
  // Time ranges ride the primary key: a v7 id encodes its own timestamp, so
  // this is a range scan on the PK rather than a second index to maintain.
  if (filter.from) where.push(gte(requestLogs.id, uuidv7Bound(filter.from)))
  if (filter.to) where.push(lt(requestLogs.id, uuidv7Bound(filter.to)))
  if (filter.apiKeyId) where.push(eq(requestLogs.apiKeyId, filter.apiKeyId))
  if (filter.model) where.push(eq(requestLogs.model, filter.model))
  if (filter.outcome) where.push(eq(requestLogs.outcome, filter.outcome))
  if (filter.statusClass === 'success') where.push(lt(requestLogs.status, 400))
  if (filter.statusClass === 'client_error') {
    where.push(gte(requestLogs.status, 400), lt(requestLogs.status, 500))
  }
  if (filter.statusClass === 'server_error') where.push(gte(requestLogs.status, 500))
  return where
}

export const postgresStore: ReadableRequestLogStore = {
  name: 'postgres',
  readable: true,

  async write(entry: RequestLogEntry): Promise<void> {
    // One row. The payload columns live here, so the two-row transaction this
    // replaced — and the window where a log row could claim a payload that
    // was never written — are both gone.
    await db.insert(requestLogs).values({
      id: entry.id,
      apiKeyId: entry.keyId,
      keyName: entry.keyName,
      model: clamp(entry.model),
      stream: entry.stream,
      status: entry.status,
      outcome: entry.outcome,
      errorType: entry.errorType ?? null,
      errorCode: entry.errorCode ?? null,
      errorMessage: entry.errorMessage ?? null,
      latencyMs: entry.latencyMs,
      ttftMs: entry.ttftMs ?? null,
      attempts: entry.attempts,
      finalTargetId: entry.final?.targetId ?? null,
      finalProviderId: entry.final?.providerId ?? null,
      finalProvider: entry.final?.provider ?? null,
      finalUpstreamModel: clamp(entry.final?.upstreamModel),
      promptTokens: entry.usage?.promptTokens ?? null,
      completionTokens: entry.usage?.completionTokens ?? null,
      cachedTokens: entry.usage?.cachedTokens ?? null,
      reasoningTokens: entry.usage?.reasoningTokens ?? null,
      inputCostUsd: entry.cost?.inputUsd ?? null,
      cachedCostUsd: entry.cost?.cachedUsd ?? null,
      outputCostUsd: entry.cost?.outputUsd ?? null,
      costUsd: entry.cost?.totalUsd ?? null,
      pricing: entry.cost?.pricing ?? null,
      droppedParams: entry.droppedParams?.length ? entry.droppedParams : null,
      payloadCaptured: entry.payload != null,
      requestJson: entry.payload?.request ?? null,
      responseJson: entry.payload?.response ?? null,
      payloadTruncated: entry.payload?.truncated ?? false,
    })
  },

  async query(filter: LogFilter): Promise<LogPage> {
    const where = conditions(filter)
    // `before` walks toward newer rows, so it queries ascending and reverses.
    const paging = filter.before
      ? { bound: sql`${requestLogs.id} > ${filter.before}`, order: asc(requestLogs.id) }
      : {
          bound: filter.after ? sql`${requestLogs.id} < ${filter.after}` : undefined,
          order: desc(requestLogs.id),
        }
    if (paging.bound) where.push(paging.bound)

    // One extra row answers "is there another page?" without a count query.
    const found = await db
      .select(LIST_COLUMNS)
      .from(requestLogs)
      .where(where.length ? and(...where) : undefined)
      .orderBy(paging.order)
      .limit(filter.limit + 1)

    const hasMore = found.length > filter.limit
    const page = found.slice(0, filter.limit)
    const rows = (filter.before ? page.reverse() : page) as LogRow[]

    return {
      rows,
      nextCursor: rows.length && (filter.before || hasMore) ? rows[rows.length - 1].id : null,
      // On an `after` page, newer rows are guaranteed by the same invariant
      // that makes `nextCursor` safe on a `before` page: the cursor itself
      // came from a row up there. On a `before` page there is no such
      // invariant — `hasMore` (computed on the same ascending query) is the
      // only thing that actually knows whether a still-newer page exists.
      prevCursor: rows.length && (filter.after || (filter.before && hasMore)) ? rows[0].id : null,
    }
  },

  async get(id: string): Promise<LogDetail | null> {
    if (!UUID_RE.test(id)) return null

    const [log] = await db
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.id, id))
      .limit(1)

    if (!log) return null

    return {
      id: log.id,
      createdAt: log.createdAt,
      keyName: log.keyName,
      model: log.model,
      stream: log.stream,
      status: log.status,
      outcome: log.outcome,
      latencyMs: log.latencyMs,
      ttftMs: log.ttftMs,
      finalProvider: log.finalProvider,
      finalUpstreamModel: log.finalUpstreamModel,
      promptTokens: log.promptTokens,
      completionTokens: log.completionTokens,
      costUsd: log.costUsd,
      payloadCaptured: log.payloadCaptured,
      errorType: log.errorType,
      errorCode: log.errorCode,
      errorMessage: log.errorMessage,
      attempts: log.attempts,
      finalTargetId: log.finalTargetId,
      cachedTokens: log.cachedTokens,
      reasoningTokens: log.reasoningTokens,
      inputCostUsd: log.inputCostUsd,
      cachedCostUsd: log.cachedCostUsd,
      outputCostUsd: log.outputCostUsd,
      pricing: log.pricing ?? null,
      droppedParams: log.droppedParams,
      // payload_captured is the flag; the columns are the fact. A row can
      // carry the flag with nothing stored — written by an older version, or
      // edited by hand — and rendering a payload block for it would claim a
      // body that does not exist. So the columns decide, not the flag.
      payload: log.requestJson !== null || log.responseJson !== null
        ? { request: log.requestJson, response: log.responseJson, truncated: log.payloadTruncated }
        : null,
    }
  },

  /**
   * Provision ahead, then discard what aged out — in that order. If the drop
   * half throws, the months that keep writes landing have already been made.
   */
  async maintain(now: Date, settings: LoggingSettings): Promise<MaintenanceResult> {
    const created = await ensurePartitions(pool, now)
    const dropped = await dropExpiredPartitions(pool, now, settings.retentionMonths)
    return { created, dropped }
  },
}
