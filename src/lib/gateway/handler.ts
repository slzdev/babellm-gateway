import 'server-only'
import { z } from 'zod'
import { createAdapter as defaultCreateAdapter } from '@/lib/adapters/registry'
import type { AttemptContext, ModelPathOverrides, ProviderAdapter } from '@/lib/adapters/types'
import type { ApiFlavor } from '@/lib/api-flavors'
import type { ProviderRow } from '@/lib/db/schema'
import { logRequest, resolveRequestLogStore } from '@/lib/logs'
import { capPayload } from '@/lib/logs/payload'
import type {
  CostBreakdown, LogPayload, LogUsage, PricingSnapshot, RequestOutcome,
} from '@/lib/logs/types'
import { priceFor } from '@/lib/pricing'
import { uuidv7 } from '@/lib/uuid'
import {
  LimitExceededError, chargeUsage, checkLimits, rateLimitHeaders, type KeyLimits,
  type LimitSnapshot,
} from '@/lib/usage'
import { extractBearerToken, resolveApiKey, touchApiKey } from './auth'
import { costPayload, type CostPayload } from './cost'
import { GatewayError, RoutedError, errorResponse, type ClassifiedError } from './errors'
import { execute, type AttemptRecord } from './execute'
import type { IdentityOptions } from './identity'
import { openTargetsFor, recordHealth } from './health'
import { resolveModel, type Candidate } from './resolve'
import { selectOrder } from './select'
import { sseResponse, startStream, type StreamCapture, type StreamOutcome, type StreamProtocol } from './sse'
import { tagsFromRequest } from './tags'

export interface GatewayDeps {
  createAdapter: (
    provider: ProviderRow,
    flavor: ApiFlavor,
    paths: ModelPathOverrides | null,
    maxOutputTokens: number | null,
  ) => ProviderAdapter
}

const defaultDeps: GatewayDeps = { createAdapter: defaultCreateAdapter }

/**
 * The shape-specific behaviour `runGatewayRequest` needs from an ingress
 * (Chat, Responses, Embeddings) to run the shared lifecycle: bookkeeping,
 * limits, model resolution, failover and logging live once in the handler;
 * only what differs between wire formats lives behind this interface.
 */
export interface Ingress<Req, Res, Chunk = never> {
  parse(raw: unknown): Req
  modelOf(req: Req): string
  droppedFor(candidate: Candidate, req: Req): string[]
  /** `candidate` is passed for one reason: an ingress whose operation not
   *  every adapter implements has to name the target that is refusing it.
   *  `execute` is already holding it — the body is per-target — and the
   *  alternative, hanging the provider off `AttemptContext`, would hand it to
   *  every adapter to answer a question only an ingress asks. Chat and
   *  Responses ignore it. */
  run(
    adapter: ProviderAdapter,
    ctx: AttemptContext,
    req: Req,
    candidate: Candidate,
  ): Promise<Res>
  /** The last transformation before the client sees the response: gateway
   *  identity, and the cost this request is being charged. `cost` is already
   *  serialized, so no ingress has to know how CostBreakdown is rendered. */
  finish(res: Res, identity: IdentityOptions, cost: CostPayload | null): Res
  usageOf(res: Res): LogUsage | null
  /** How this dialect turns catalog rates into a charge. Chat and Responses
   *  bill input and output; a dialect with no output tokens is billed on input
   *  alone, and the rule for that lives with the dialect rather than in a
   *  handler that would have to sniff which one it is holding. The handler
   *  calls it at both pricing sites, which is what keeps the client's number,
   *  the log row and the key's billed spend one value. */
  cost(prices: PricingSnapshot | null, usage: LogUsage | null): CostBreakdown | null
  newIdentityId(): string
  /** Everything that only exists because a dialect can stream, grouped so a
   *  dialect that cannot says so by leaving it out. Absence is the honest
   *  encoding: the alternative — an `isStream` that always returns false plus
   *  three throwing stubs — is unreachable code that reads as reachable, and
   *  it leaves the compiler nothing to object to when a later refactor calls
   *  `runStream` unconditionally. Omitted, the handler's streaming branch is
   *  unreachable by type rather than by convention. */
  streaming?: {
    isStream(req: Req): boolean
    runStream(adapter: ProviderAdapter, ctx: AttemptContext, req: Req): AsyncIterable<Chunk>
    protocol: StreamProtocol<Chunk>
    /** What payload capture stores for an interrupted or completed stream. */
    captureResponse(identity: IdentityOptions, capture: StreamCapture, outcome: StreamOutcome): unknown
  }
}

export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = (result.error as z.ZodError).issues[0]
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request',
      param: issue.path.length > 0 ? String(issue.path[0]) : null,
      message: `${issue.path.join('.') || 'body'}: ${issue.message}`,
    })
  }
  return result.data
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_json',
      message: 'Request body could not be parsed as JSON.',
    })
  }
}

/**
 * The body to send to one particular target.
 *
 * A target with no tier gets the client's own object back, unchanged and
 * un-copied: "(none)" has to mean the request is not touched, which includes
 * not adding a `service_tier: null` the caller never sent. A configured tier
 * overwrites whatever the client asked for — it is an operator's routing
 * decision, not a default.
 *
 * Shared by all three ingresses. The two chat dialects spell it
 * `service_tier` at the top level, so there is nothing per-shape to decide
 * between them, and the embeddings dialect has no such parameter at all —
 * which makes a pinned tier inert there rather than wrong: an OpenAI-shaped
 * upstream ignores it as it ignores any undocumented parameter, and Gemini's
 * embeddings translator builds its parameters explicitly and never reads it.
 * Left uniform on purpose. Excepting embeddings here would buy nothing on the
 * upstreams that ignore the field and would silently un-pin a clone that does
 * honour a tier on it.
 */
function bodyFor<Req>(candidate: Candidate, body: Req): Req {
  if (!candidate.serviceTier) return body
  return { ...body, service_tier: candidate.serviceTier }
}

export function attemptHeaders(
  candidate: Candidate,
  requestId: string,
  dropped: string[] = [],
  limits: LimitSnapshot | null = null,
): HeadersInit {
  return {
    'x-request-id': requestId,
    'x-babellm-provider': candidate.provider.name,
    'x-babellm-upstream-model': candidate.upstreamModel,
    ...(dropped.length > 0 ? { 'x-babellm-dropped-params': dropped.join(',') } : {}),
    ...rateLimitHeaders(limits),
  }
}

const ERROR_MESSAGE_MAX_LENGTH = 2000

/**
 * Bounds and packages a request/response pair for storage.
 *
 * Capping happens here, before the write, so the store's insert can be a
 * single transaction whose only remaining failure mode is the database
 * itself.
 */
function buildPayload(
  request: unknown,
  response: unknown,
  maxBytes: number,
  truncatedUpstream = false,
): LogPayload {
  const cappedRequest = capPayload(request, maxBytes)
  const cappedResponse = capPayload(response, maxBytes)
  return {
    request: cappedRequest.value,
    response: cappedResponse.value,
    truncated: truncatedUpstream || cappedRequest.truncated || cappedResponse.truncated,
  }
}

/** The log keeps the real message even for an unhandled error: the page that
 * reads it is admin-only, and the sanitized envelope the client received is
 * useless for diagnosis. Length is still bounded — a provider that fails
 * with a multi-megabyte HTML body must not turn into a multi-megabyte row. */
function errorMessage(message: string): string {
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH)
    : message
}

// A ClassifiedError (from sse.ts's stream_interrupted path) is a plain
// object, not an Error instance, so it needs its own check rather than
// falling through to the generic branch below and being mislabeled
// "internal_error".
function isClassifiedError(err: unknown): err is ClassifiedError {
  return typeof err === 'object' && err !== null && 'retryable' in err && 'message' in err
}

function errorFields(err: unknown) {
  if (err === undefined) return {}
  if (err instanceof GatewayError) {
    return { errorType: err.type, errorCode: err.code, errorMessage: errorMessage(err.message) }
  }
  if (isClassifiedError(err)) {
    return { errorType: err.type, errorCode: err.code, errorMessage: errorMessage(err.message) }
  }
  return {
    errorType: 'internal_error',
    errorCode: null,
    errorMessage: errorMessage(err instanceof Error ? err.message : String(err)),
  }
}

export async function runGatewayRequest<Req, Res, Chunk>(
  request: Request,
  ingress: Ingress<Req, Res, Chunk>,
  deps: GatewayDeps = defaultDeps,
): Promise<Response> {
  // The request's one identifier: returned as x-request-id, stored as the
  // log's primary key, and — because it is a v7 uuid — the partition that log
  // row lands in. Minted here rather than at insert, because the header goes
  // out long before the row is written.
  const requestId = uuidv7()
  const startedAt = Date.now()
  // Hoisted into a local because a property access cannot be narrowed: the
  // streaming branch below needs TypeScript to know the block is present, and
  // only a `const` gives it that.
  const streaming = ingress.streaming

  // Tracked outside the try so the log line can still say who was calling
  // and for what when the request never got as far as an attempt.
  let keyId: string | null = null
  let keyName: string | null = null
  let modelName: string | null = null
  let stream = false
  let dropped: string[] = []
  // Parsed before anything else can fail, so a request that dies in body
  // parsing, routing, or upstream still carries its tags on the log row.
  let tags: Record<string, string> | null = null
  // Payload capture is per key and off by default, so the cost of assembling
  // and storing bodies falls only on the keys that asked for it.
  let capturePayloads = false
  let requestBody: Req | null = null
  // Held for the charge that happens after the response, and for the headers
  // every response carries.
  let limitedKey: KeyLimits | null = null
  let limits: LimitSnapshot | null = null

  interface LogExtra {
    ttftMs?: number
    /** The target that actually served, which is what gets priced. */
    candidate?: Candidate
    usage?: LogUsage | null
    /** The cost the client was given, so the log, the client, and the key's
     *  billed spend cannot disagree. Absent on paths that never priced
     *  anything — errors, and streams that ended before usage arrived. */
    cost?: CostBreakdown | null
    /** What the client received, for payload capture. */
    response?: unknown
    responseTruncated?: boolean
    error?: unknown
  }

  function log(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    extra: LogExtra = {},
  ) {
    // Fire-and-forget. A request that succeeded must not be failed — or even
    // slowed — by its own bookkeeping.
    void writeLog(status, outcome, attempts, extra).catch((err) =>
      console.error(`[gateway] failed to write request log request_id=${requestId}`, err),
    )
  }

  async function writeLog(
    status: number,
    outcome: RequestOutcome,
    attempts: AttemptRecord[],
    extra: LogExtra,
  ) {
    const usage = extra.usage ?? null
    // Computed on the response path, not here. Recomputing would issue a
    // second catalog lookup that could straddle a price change or the price
    // cache's TTL, and a client reconciling its own tally against this row
    // would have no guarantee the two came from the same snapshot.
    const cost = extra.cost ?? null

    // Charge the key's counters here because this is the one place that has
    // both the measured usage and the priced cost. Never awaited by the
    // response path — writeLog is already fire-and-forget.
    if (limitedKey && usage) {
      void chargeUsage(
        limitedKey,
        (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
        cost?.totalUsd ?? null,
      )
    }
    const { settings } = await resolveRequestLogStore()

    const payload =
      capturePayloads && requestBody
        ? buildPayload(
            requestBody,
            extra.response ?? null,
            settings.payloadMaxBytes,
            extra.responseTruncated ?? false,
          )
        : null

    await logRequest({
      id: requestId,
      keyId,
      keyName,
      model: modelName,
      stream,
      status,
      outcome,
      ...errorFields(extra.error),
      latencyMs: Date.now() - startedAt,
      ...(extra.ttftMs === undefined ? {} : { ttftMs: extra.ttftMs }),
      attempts,
      final: extra.candidate
        ? {
            targetId: extra.candidate.targetId,
            providerId: extra.candidate.provider.id,
            provider: extra.candidate.provider.name,
            upstreamModel: extra.candidate.upstreamModel,
          }
        : null,
      usage,
      cost,
      ...(dropped.length > 0 ? { droppedParams: dropped } : {}),
      tags,
      payload,
    })
  }

  try {
    const apiKey = await resolveApiKey(extractBearerToken(request))
    keyId = apiKey.id
    keyName = apiKey.name
    capturePayloads = apiKey.logPayloads
    // After resolveApiKey so the rejection is attributable — the catch below
    // logs any GatewayError thrown in here, and reads keyId/keyName from this
    // scope. Before the body parse because it is the cheaper check, and
    // because it puts the tags in scope for every failure path after it.
    tags = tagsFromRequest(request)
    const body = ingress.parse(await readJson(request))
    requestBody = body
    modelName = ingress.modelOf(body)
    stream = streaming?.isStream(body) ?? false

    // After parsing so a malformed body cannot consume rpm, and before
    // resolving the model so a throttled key does not cost a database lookup
    // — and so a key that is over its limit is told so, rather than being
    // told its model does not exist.
    limitedKey = apiKey
    limits = await checkLimits(apiKey)

    const { model, candidates } = await resolveModel(modelName)
    const open = await openTargetsFor(candidates)
    const chain = selectOrder(candidates, model, { open })

    void touchApiKey(apiKey.id).catch((err) =>
      console.error(`[gateway] failed to update last_used_at request_id=${requestId}`, err),
    )

    const identity = { id: ingress.newIdentityId(), model: modelName }

    if (streaming && stream) {
      // startStream pulls the first chunk, so a failure inside `run` is
      // still a failure before the response is committed — which is what
      // makes failover safe for streams.
      const result = await execute(
        chain, requestId, request.signal, { ...deps, recordHealth },
        (adapter, ctx, candidate) =>
          startStream(streaming.runStream(adapter, ctx, bodyFor(candidate, body))),
      )
      // Against the body the winning target was actually sent, not the client's
      // — otherwise a tier this gateway added would be dropped by a Gemini
      // target without ever being reported.
      dropped = ingress.droppedFor(result.candidate, bodyFor(result.candidate, body))
      // Resolved only when its value is actually used: for the default case
      // (capture off) this settings lookup would otherwise sit unconditionally
      // between execute() and the response, adding to time-to-first-token for
      // a value the `capturePayloads ? … : undefined` below throws away.
      const captureOptions = capturePayloads
        ? { maxBytes: (await resolveRequestLogStore()).settings.payloadMaxBytes }
        : undefined

      // Started, deliberately not awaited: handler.ts must put nothing
      // between execute() and the response, or it lands on
      // time-to-first-token. The relay awaits this only on the chunk that
      // carries usage — the last one — by which point it has long resolved.
      //
      // The .catch is attached here rather than at the await because a stream
      // that ends without usage never awaits it at all, and an unattended
      // rejection would take down the process precisely when the database is
      // already in trouble.
      const prices = priceFor(
        result.candidate.provider.id,
        result.candidate.upstreamModel,
      ).catch(() => null)

      return sseResponse(
        result.value,
        streaming.protocol,
        identity,
        attemptHeaders(result.candidate, requestId, dropped, limits),
        (outcome, capture) =>
          log(200, outcome, result.attempts, {
            ...(capture.firstDeltaAt === null ? {} : { ttftMs: capture.firstDeltaAt - startedAt }),
            candidate: result.candidate,
            usage: capture.usage,
            cost: capture.cost,
            error: capture.error ?? undefined,
            response: capturePayloads ? streaming.captureResponse(identity, capture, outcome) : null,
            responseTruncated: capture.truncated,
          }),
        captureOptions,
        async (usage) => ingress.cost(await prices, usage),
      )
    }

    const result = await execute(
      chain, requestId, request.signal, { ...deps, recordHealth },
      (adapter, ctx, candidate) => ingress.run(adapter, ctx, bodyFor(candidate, body), candidate),
    )
    dropped = ingress.droppedFor(result.candidate, bodyFor(result.candidate, body))

    // Usage is read first so a provider that reports none skips the catalog
    // lookup entirely — otherwise a SELECT would sit on the client's critical
    // path to compute a cost that's unconditionally null. The catalog may
    // never fail a request either way: a price lookup that throws costs the
    // client its cost breakdown, not its completion, so the rejection is
    // swallowed at creation rather than caught at the await, which also keeps
    // the streaming path (where this promise may never be awaited at all)
    // from raising an unhandled rejection.
    const usage = ingress.usageOf(result.value)
    const prices = usage
      ? await priceFor(
          result.candidate.provider.id,
          result.candidate.upstreamModel,
        ).catch(() => null)
      : null
    const cost = ingress.cost(prices, usage)

    // Built before logging: logging after the response has been constructed
    // means a throw building the response can no longer race a second,
    // contradictory log line against this one for the same request_id.
    const completion = ingress.finish(result.value, identity, costPayload(cost))
    const response = Response.json(completion, {
      headers: attemptHeaders(result.candidate, requestId, dropped, limits),
    })
    log(200, 'ok', result.attempts, {
      candidate: result.candidate,
      usage,
      cost,
      response: completion,
    })
    return response
  } catch (err) {
    // Deliberately not logged. A limit rejection never reached a provider,
    // and one log row per rejected request is the traffic pattern that grows
    // fastest exactly when the gateway is under the most stress.
    if (err instanceof LimitExceededError) {
      return errorResponse(err, { 'x-request-id': requestId, ...err.headers })
    }

    const status = err instanceof GatewayError ? err.status : 500
    // A client that disconnected mid-request surfaces here as an aborted
    // signal, which classifyProviderError reports as an upstream timeout —
    // that's the right status for a stuck response, but the wrong outcome:
    // the client left, no upstream is to blame.
    const outcome: RequestOutcome = request.signal.aborted ? 'client_closed' : 'error'
    log(status, outcome, err instanceof RoutedError ? err.attempts : [], { error: err })

    // Under failover the interesting provider is the last one tried, which
    // only the routed error knows.
    const headers: HeadersInit =
      err instanceof RoutedError && err.lastProvider
        ? { 'x-request-id': requestId, 'x-babellm-provider': err.lastProvider }
        : { 'x-request-id': requestId }
    return errorResponse(err, headers)
  }
}
