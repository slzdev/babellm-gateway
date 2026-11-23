import type { ProviderConfig } from '@/lib/adapters/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

export interface BedrockReasoning {
  /** Merged into additionalModelRequestFields; absent when nothing to send. */
  fields?: Record<string, unknown>
  /** Set only when the legacy budget path needs a max the client didn't give. */
  maxTokens?: number
  /** True when a non-empty, non-'none' reasoning_effort was expressed. */
  translated: boolean
}

// Same alias the Anthropic adapter applies: Claude has no `minimal` level.
// Kept local so the two adapters do not grow a dependency on each other.
const CLAUDE_EFFORT_ALIASES: Record<string, string> = { minimal: 'low' }

// Models that only accept a token budget for thinking. A closed list: no
// future model will be budget-only, so every other Claude ID is adaptive and
// new releases need no code change.
const LEGACY_BUDGET =
  /claude-(?:3-7-|(?:sonnet|opus)-4-\d{8}|opus-4-1-|(?:sonnet|haiku|opus)-4-5-)/
// Claude generations with no extended thinking at all.
const NO_THINKING = /claude-(?:3-(?!7)|instant)/

const BUDGETS: Record<string, number> = { low: 2048, medium: 8192, high: 16384 }
// Anthropic rejects a thinking budget below this.
const MIN_BUDGET = 1024
// Headroom for the visible answer when the client gave no max of its own.
const ANSWER_HEADROOM = 4096

const ADAPTIVE = { type: 'adaptive', display: 'summarized' }

function modelId(upstreamModel: string): string {
  // Foundation-model and inference-profile ARNs end in the model ID. A geo
  // prefix (`us.`, `eu.`, `global.`, …) is stripped only in front of a family
  // we recognize, so an opaque ID is never mistaken for one.
  const id = upstreamModel.slice(upstreamModel.lastIndexOf('/') + 1)
  return id.replace(/^[a-z]+\.(?=(?:anthropic|openai)\.)/, '')
}

export function bedrockReasoning(
  req: ChatCompletionRequest,
  upstreamModel: string,
  config: ProviderConfig = {},
): BedrockReasoning {
  const raw = req.reasoning_effort
  // `none` is a client saying it does not want reasoning, expressed by
  // sending nothing, and it wins over the provider opt-in.
  if (raw === 'none') return { translated: false }
  const requested = raw ? raw : undefined
  const optIn = config.requestReasoningSummary === true
  if (requested === undefined && !optIn) return { translated: false }

  const id = modelId(upstreamModel)

  if (id.startsWith('openai.')) {
    return {
      fields: { reasoning: requested ? { effort: requested, summary: 'auto' } : { summary: 'auto' } },
      translated: requested !== undefined,
    }
  }

  if (!id.startsWith('anthropic.claude-') || NO_THINKING.test(id)) return { translated: false }

  const effort = requested === undefined ? undefined : CLAUDE_EFFORT_ALIASES[requested] ?? requested

  if (!LEGACY_BUDGET.test(id)) {
    return {
      fields: { thinking: ADAPTIVE, ...(effort ? { output_config: { effort } } : {}) },
      translated: effort !== undefined,
    }
  }

  // Legacy models: anything beyond `high` (xhigh, max, …) gets high's budget,
  // and the opt-in with no effort gets the middle one.
  let budget = BUDGETS[effort ?? 'medium'] ?? BUDGETS.high
  const clientMax = req.max_completion_tokens ?? req.max_tokens ?? undefined
  let maxTokens: number | undefined
  if (clientMax === undefined) {
    maxTokens = budget + ANSWER_HEADROOM
  } else if (clientMax <= budget) {
    budget = clientMax - 1
  }
  // Too little room left to think: send no thinking and let the caller report
  // the effort as dropped rather than sending a budget upstream would reject.
  if (budget < MIN_BUDGET) return { translated: false }

  return {
    fields: { thinking: { type: 'enabled', budget_tokens: budget } },
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    translated: effort !== undefined,
  }
}
