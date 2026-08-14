import 'server-only'
import type { LoggingSettings } from '@/lib/settings'
import { addMonths, monthStart } from '../months'
import { capPayload } from '../payload'
import type {
  LogDetail, LoggedAttempt, LogRow, PricingSnapshot, RequestLogEntry, RequestOutcome,
} from '../types'
import { shardKey } from './keys'

/** Per side, and deliberately below the settings-level payloadMaxBytes: the
 * handler caps request and response independently, so a 256 KiB setting can
 * hand this store half a megabyte — past DynamoDB's 400 KB item limit. */
export const DYNAMO_PAYLOAD_MAX_BYTES = 150 * 1024

/** Headroom under the 400 KB hard limit for keys, metadata, and attribute
 * names. */
export const ITEM_MAX_BYTES = 380 * 1024

const MODEL_MAX_LENGTH = 128

/** Retry chains are bounded by routing configuration long before this, and an
 * upstream error message is usually a sentence. Neither is bounded by the
 * type system, though, and "bounded in practice" is not bounded — see the
 * shed stages in toItem. */
const MAX_STORED_ATTEMPTS = 100
const ERROR_MESSAGE_MAX_LENGTH = 4096

export type LogItem = Record<string, unknown> & { pk: string; sk: string }

/** Matches postgres.ts so that `filter.model` equality behaves identically on
 * both drivers, even though DynamoDB has no column length to overflow. */
function clamp(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > MODEL_MAX_LENGTH ? value.slice(0, MODEL_MAX_LENGTH) : value
}

/** Omits nullish instead of storing NULL. DynamoDB is schemaless, so an
 * absent attribute costs nothing at all — and the read mappers put the null
 * back. */
function put(item: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) item[key] = value
}

/**
 * The instant this entry should disappear, in epoch seconds.
 *
 * `dropExpiredPartitions` drops month M when `M < addMonths(now, -(n - 1))`,
 * which rearranges to: M drops when `now >= addMonths(M, n)`. Stamping that
 * makes retention behave identically on both drivers rather than
 * approximately.
 *
 * Zero keeps everything, mirroring `if (retentionMonths <= 0) return []`.
 */
export function expiresAtFor(writtenAt: Date, retentionMonths: number): number | null {
  if (retentionMonths <= 0) return null
  return Math.floor(addMonths(monthStart(writtenAt), retentionMonths).getTime() / 1000)
}

export function toItem(
  entry: RequestLogEntry,
  settings: LoggingSettings,
  writtenAt: Date = new Date(),
): LogItem {
  const item: Record<string, unknown> = {
    pk: shardKey(entry.id),
    // The id is stored once, as the sort key. A second copy would add ~40
    // bytes an item to duplicate something already there.
    sk: entry.id,
    createdAt: writtenAt.getTime(),
    stream: entry.stream,
    status: entry.status,
    outcome: entry.outcome,
    latencyMs: entry.latencyMs,
    payloadCaptured: entry.payload != null,
  }

  put(item, 'expiresAt', expiresAtFor(writtenAt, settings.retentionMonths))
  put(item, 'apiKeyId', entry.keyId)
  put(item, 'keyName', clamp(entry.keyName))
  put(item, 'model', clamp(entry.model))
  // errorType/errorCode come off ProviderError, which an adapter builds
  // straight from an upstream's JSON error body — an "OpenAI-compatible"
  // third party can put an arbitrarily long string in either. Clamped
  // unconditionally, like model, rather than left to the shed: they are
  // short identifiers in practice, so nothing real is lost, and it keeps
  // them out of the set of fields the shed has to know about.
  put(item, 'errorType', clamp(entry.errorType))
  put(item, 'errorCode', clamp(entry.errorCode))
  put(item, 'errorMessage', entry.errorMessage)
  put(item, 'ttftMs', entry.ttftMs)
  put(item, 'finalTargetId', entry.final?.targetId)
  put(item, 'finalProviderId', entry.final?.providerId)
  put(item, 'finalProvider', clamp(entry.final?.provider))
  put(item, 'finalUpstreamModel', clamp(entry.final?.upstreamModel))
  put(item, 'promptTokens', entry.usage?.promptTokens)
  put(item, 'completionTokens', entry.usage?.completionTokens)
  put(item, 'cachedTokens', entry.usage?.cachedTokens)
  put(item, 'reasoningTokens', entry.usage?.reasoningTokens)
  put(item, 'inputCostUsd', entry.cost?.inputUsd)
  put(item, 'cachedCostUsd', entry.cost?.cachedUsd)
  put(item, 'outputCostUsd', entry.cost?.outputUsd)
  put(item, 'costUsd', entry.cost?.totalUsd)
  put(item, 'pricing', entry.cost?.pricing)
  if (entry.attempts.length) item.attempts = entry.attempts
  if (entry.droppedParams?.length) item.droppedParams = entry.droppedParams

  if (entry.payload) {
    // Re-capping with the existing helper means an oversized body gets the
    // same truncation envelope the detail page already renders, rather than
    // a second shape the UI would have to learn.
    const request = capPayload(entry.payload.request, DYNAMO_PAYLOAD_MAX_BYTES)
    const response = capPayload(entry.payload.response, DYNAMO_PAYLOAD_MAX_BYTES)
    if (request.value !== null) item.requestJson = JSON.stringify(request.value)
    if (response.value !== null) item.responseJson = JSON.stringify(response.value)
    item.payloadTruncated = entry.payload.truncated || request.truncated || response.truncated
  }

  shed(item)
  return item as LogItem
}

/** Measured on the serialized record. JSON punctuation makes this a slight
 * over-estimate of DynamoDB's own accounting, which is the safe direction. */
function fits(item: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(item), 'utf8') <= ITEM_MAX_BYTES
}

/**
 * Sheds content, in order of least structural value, until the item fits.
 *
 * A ValidationException here would lose the entire log line, and logRequest is
 * deliberately not awaited on the request path — the loss would surface only
 * as a stderr line. So the item has to fit by construction, which means every
 * unbounded field needs a stage or an unconditional clamp: `attempts` grows
 * with a misconfigured route, `errorMessage` is whatever an upstream provider
 * chose to return, and `droppedParams` grows with the request. Capping
 * payloads alone leaves all three able to blow the limit on their own.
 *
 * The shed terminates because nothing it can still touch is unbounded: every
 * field it doesn't reach — errorType, errorCode, keyName, finalProvider,
 * model, finalUpstreamModel — is clamped unconditionally in toItem before
 * shed() ever runs, and everything else is a number, boolean, uuid, or
 * fixed-shape object. Each stage below runs only if the item is still
 * oversized, so an ordinary entry — which is a few KB — passes through
 * untouched.
 */
function shed(item: Record<string, unknown>): void {
  // 1. Payloads: the biggest, and the only part the UI already has a shape
  //    for reporting as missing.
  if (!fits(item)) {
    const envelope = JSON.stringify({ truncated: true, error: 'too_large_for_store' })
    if (item.requestJson !== undefined) item.requestJson = envelope
    if (item.responseJson !== undefined) item.responseJson = envelope
    item.payloadTruncated = true
  }

  // 2. Unbounded scalars from upstream.
  if (!fits(item)) {
    if (typeof item.errorMessage === 'string') {
      item.errorMessage = item.errorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH)
    }
    delete item.droppedParams
  }

  // 3. The retry chain. Kept last because it is the most diagnostic thing
  //    here — a request that failed enough to grow a long chain is exactly
  //    the one someone will open the detail page for.
  if (!fits(item) && Array.isArray(item.attempts)) {
    item.attempts = (item.attempts as LoggedAttempt[])
      .slice(0, MAX_STORED_ATTEMPTS)
      .map((attempt) => ({
        ...attempt,
        targetId: attempt.targetId.slice(0, MODEL_MAX_LENGTH),
        provider: attempt.provider.slice(0, MODEL_MAX_LENGTH),
        model: attempt.model.slice(0, MODEL_MAX_LENGTH),
        ...(attempt.error === undefined
          ? {}
          : { error: attempt.error.slice(0, MODEL_MAX_LENGTH) }),
      }))
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function toRow(item: Record<string, unknown>): LogRow {
  return {
    id: String(item.sk),
    createdAt: new Date(Number(item.createdAt)),
    keyName: str(item.keyName),
    model: str(item.model),
    stream: item.stream === true,
    status: Number(item.status),
    outcome: item.outcome as RequestOutcome,
    latencyMs: Number(item.latencyMs),
    ttftMs: num(item.ttftMs),
    finalProvider: str(item.finalProvider),
    finalUpstreamModel: str(item.finalUpstreamModel),
    promptTokens: num(item.promptTokens),
    completionTokens: num(item.completionTokens),
    costUsd: str(item.costUsd),
    payloadCaptured: item.payloadCaptured === true,
  }
}

export function toDetail(item: Record<string, unknown>): LogDetail {
  return {
    ...toRow(item),
    errorType: str(item.errorType),
    errorCode: str(item.errorCode),
    errorMessage: str(item.errorMessage),
    attempts: (item.attempts as LoggedAttempt[] | undefined) ?? [],
    finalTargetId: str(item.finalTargetId),
    cachedTokens: num(item.cachedTokens),
    reasoningTokens: num(item.reasoningTokens),
    inputCostUsd: str(item.inputCostUsd),
    cachedCostUsd: str(item.cachedCostUsd),
    outputCostUsd: str(item.outputCostUsd),
    pricing: (item.pricing as PricingSnapshot | undefined) ?? null,
    droppedParams: (item.droppedParams as string[] | undefined) ?? null,
    // The stored attributes are the fact; payloadCaptured is only a flag. An
    // item can carry the flag with nothing stored — written by an older
    // version, or edited by hand — and rendering a payload block for it would
    // claim a body that does not exist.
    payload: item.requestJson !== undefined || item.responseJson !== undefined
      ? {
          request: item.requestJson === undefined ? null : JSON.parse(String(item.requestJson)),
          response: item.responseJson === undefined ? null : JSON.parse(String(item.responseJson)),
          truncated: item.payloadTruncated === true,
        }
      : null,
  }
}
