import 'server-only'
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requestLogs, requestPayloads } from '@/lib/db/schema'
import { uuidv7Bound } from '@/lib/uuid'
import type {
  LogDetail, LogFilter, LogPage, LogRow, ReadableRequestLogStore, RequestLogEntry,
} from './types'

const MODEL_MAX_LENGTH = 128
const PRUNE_BATCH = 5000

/** An absurd model name in a request must not become a failed insert that
 * loses the log line. */
function clamp(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > MODEL_MAX_LENGTH ? value.slice(0, MODEL_MAX_LENGTH) : value
}

const LIST_COLUMNS = {
  id: requestLogs.id,
  requestId: requestLogs.requestId,
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
    // One transaction for both rows. Capping already happened in the caller,
    // so the only remaining failure mode is the database itself — and losing
    // both rows together is the coherent outcome.
    await db.transaction(async (tx) => {
      const [row] = await tx.insert(requestLogs).values({
        requestId: entry.requestId,
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
      }).returning({ id: requestLogs.id })

      if (entry.payload) {
        await tx.insert(requestPayloads).values({
          requestLogId: row.id,
          requestJson: entry.payload.request,
          responseJson: entry.payload.response,
          truncated: entry.payload.truncated,
        })
      }
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

  async get(requestId: string): Promise<LogDetail | null> {
    const [found] = await db
      .select({ log: requestLogs, payload: requestPayloads })
      .from(requestLogs)
      .leftJoin(requestPayloads, eq(requestPayloads.requestLogId, requestLogs.id))
      .where(eq(requestLogs.requestId, requestId))
      .limit(1)

    if (!found) return null
    const { log, payload } = found

    return {
      id: log.id,
      requestId: log.requestId,
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
      // A payload row can be absent even when payload_captured is true, if the
      // row was written by an older version or removed by hand. Read it
      // defensively rather than trusting the flag.
      payload: payload
        ? { request: payload.requestJson, response: payload.responseJson, truncated: payload.truncated }
        : null,
    }
  },

  async prune(olderThan: Date): Promise<number> {
    const bound = uuidv7Bound(olderThan)
    let total = 0

    // Batched so a first prune over a large backlog never holds one enormous
    // transaction. `id <` is a range scan on the primary key, and payloads
    // follow through the cascade.
    for (;;) {
      const result = await db.execute(sql`
        DELETE FROM request_logs
        WHERE id IN (
          SELECT id FROM request_logs WHERE id < ${bound} ORDER BY id LIMIT ${PRUNE_BATCH}
        )
      `)
      const deleted = result.rowCount ?? 0
      total += deleted
      if (deleted < PRUNE_BATCH) return total
    }
  },
}
