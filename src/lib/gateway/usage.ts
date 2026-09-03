import type { LogUsage } from '@/lib/logs/types'

interface RawUsage {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  prompt_tokens_details?: { cached_tokens?: number | null } | null
  completion_tokens_details?: { reasoning_tokens?: number | null } | null
}

// `unknown` rather than `number | null | undefined`: usageFromTranscription
// below reads an untyped upstream object, and the check this performs is
// exactly the one such a field needs anyway.
function count(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/**
 * Normalizes an upstream `usage` object.
 *
 * Returns null when the provider reported nothing — a provider configured
 * with disableStreamUsage, or one whose clone omits the field. Absent counts
 * stay null rather than becoming 0: "we did not measure it" and "it was free"
 * must not render identically.
 */
export function usageFrom(raw: RawUsage | null | undefined): LogUsage | null {
  if (!raw) return null
  return {
    promptTokens: count(raw.prompt_tokens),
    completionTokens: count(raw.completion_tokens),
    cachedTokens: count(raw.prompt_tokens_details?.cached_tokens),
    reasoningTokens: count(raw.completion_tokens_details?.reasoning_tokens),
  }
}

interface RawResponsesUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  input_tokens_details?: { cached_tokens?: number | null } | null
  output_tokens_details?: { reasoning_tokens?: number | null } | null
}

/**
 * The Responses spelling of the same four numbers. A second normalizer rather
 * than a union inside usageFrom, because the two shapes share no field name and
 * a merged function would have to guess which dialect it was handed.
 */
export function usageFromResponses(raw: RawResponsesUsage | null | undefined): LogUsage | null {
  if (!raw) return null
  return {
    promptTokens: count(raw.input_tokens),
    completionTokens: count(raw.output_tokens),
    cachedTokens: count(raw.input_tokens_details?.cached_tokens),
    reasoningTokens: count(raw.output_tokens_details?.reasoning_tokens),
  }
}

/**
 * The transcription spelling — the third of the same numbers, and the only one
 * that can legitimately measure nothing at all.
 *
 * Two variants arrive under one field name, told apart by their own `type`
 * discriminant: `{ type: 'tokens', input_tokens, output_tokens }` from the
 * `gpt-4o-transcribe` family, and `{ type: 'duration', seconds }` from
 * `whisper-1` and its clones. So the parameter is `unknown`: `type` has to be
 * read before any other field can be trusted, and a Whisper clone may send a
 * third shape nobody has seen.
 *
 * Duration-billed usage returns **null**, not zeroes. It measures seconds of
 * audio, which the catalog's per-Mtok columns cannot price, and the standing
 * rule is that a request which cannot be priced reports "unpriced" — a
 * dashboard showing $0.00 for real spend is worse than one showing nothing
 * (design doc §3.8). `seconds` is emphatically never returned as a token
 * count: a duration in a token column would corrupt every rollup that sums
 * tokens.
 *
 * Neither variant reports cached or reasoning tokens — the dialect has no such
 * fields — so both stay null: not measured, rather than measured as 0.
 */
export function usageFromTranscription(raw: unknown): LogUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as { type?: unknown; input_tokens?: unknown; output_tokens?: unknown }
  if (usage.type !== 'tokens') return null
  return {
    promptTokens: count(usage.input_tokens),
    completionTokens: count(usage.output_tokens),
    cachedTokens: null,
    reasoningTokens: null,
  }
}

interface RawEmbeddingsUsage {
  prompt_tokens?: number | null
  /** Declared to match the upstream object and nothing more. LogUsage has no
   *  total, and the callers that want one add the two counts themselves. */
  total_tokens?: number | null
}

/**
 * The embeddings spelling, which reports one number worth keeping.
 *
 * `completionTokens` is 0 where usageFrom would leave it null, and that is the
 * point: an embeddings response has no output tokens to measure, so zero is
 * the measurement rather than the absence of one. Null would say "unmeasured"
 * and make an otherwise fully-measured request unpriceable.
 *
 * Null is still right for the two details, which no provider reports on this
 * endpoint, and for the whole object when the response carries no usage at all
 * — Gemini's embedContent measures nothing, and inventing a zero there would
 * claim a measurement that never happened.
 */
export function usageFromEmbeddings(raw: RawEmbeddingsUsage | null | undefined): LogUsage | null {
  if (!raw) return null
  return {
    promptTokens: count(raw.prompt_tokens),
    completionTokens: 0,
    cachedTokens: null,
    reasoningTokens: null,
  }
}
