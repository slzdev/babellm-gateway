import type { LogUsage } from '@/lib/logs/types'

interface RawUsage {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  prompt_tokens_details?: { cached_tokens?: number | null } | null
  completion_tokens_details?: { reasoning_tokens?: number | null } | null
}

function count(value: number | null | undefined): number | null {
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
