import type { EmbeddingsResult } from '@/lib/adapters/types'
import { API_FLAVOR_LABELS } from '@/lib/api-flavors'
import { computeInputOnlyCost } from '@/lib/pricing'
import { embeddingsRequestSchema, type EmbeddingsRequest } from '@/lib/schemas/embeddings'
import { withUsageCost } from '../cost'
import { UnsupportedOperationError } from '../errors'
import { parseWith, type Ingress } from '../handler'
import { newEmbeddingsId, rewriteEmbeddings } from '../identity'
import type { Candidate } from '../resolve'
import { usageFromEmbeddings } from '../usage'
import { droppedForEmbeddings } from './dropped'

/**
 * The answer a target that cannot embed gives, and the only place that answer
 * lives.
 *
 * `embed` is optional on `ProviderAdapter` because no wrapper can synthesize
 * an embedding out of a chat completion the way `withRespondViaChat`
 * synthesizes a Response — so the adapters state what they can do by
 * presence, and turning that absence into an HTTP answer is the ingress's job
 * rather than each adapter's.
 *
 * `classifyProviderError` reads `UnsupportedOperationError` as a non-retryable
 * 501, so the chain stops here instead of trying the next target. That is the
 * intent, not a limitation: a virtual model's targets are meant to be
 * interchangeable, one that cannot serve the operation at all is a
 * configuration error, and failing over would hide it behind a working sibling
 * until the day that sibling is down. Non-retryable also keeps `execute` from
 * reporting health, so a provider that is perfectly reachable does not open a
 * breaker by declining an ability it never claimed.
 *
 * The flavor is named alongside the provider because it is usually the lever:
 * an `openai_compatible` provider embeds fine until a target pins it to
 * `anthropic_messages`, and the fix is on the same page as the cause.
 */
function refuseEmbeddings(candidate: Candidate): UnsupportedOperationError {
  return new UnsupportedOperationError(
    `Provider "${candidate.provider.name}" cannot serve embeddings on the `
    + `${API_FLAVOR_LABELS[candidate.apiFlavor]} API flavor: its adapter has no embeddings `
    + 'endpoint. On the Catalog page, either point this model at a target whose provider '
    + 'speaks an OpenAI-shaped or Gemini dialect, or change this target\'s API flavor. '
    + 'The request was not retried against another target, because a target that cannot '
    + 'serve the operation is a misconfiguration rather than an outage.',
  )
}

export const embeddingsIngress: Ingress<EmbeddingsRequest, EmbeddingsResult> = {
  parse: (raw) => parseWith(embeddingsRequestSchema, raw),
  modelOf: (req) => req.model,
  droppedFor: (candidate, req) => droppedForEmbeddings(candidate, req),
  run: (adapter, ctx, req, candidate) => {
    if (!adapter.embed) throw refuseEmbeddings(candidate)
    return adapter.embed(req, ctx)
  },
  finish: (res, identity, cost) => withUsageCost(rewriteEmbeddings(res, identity), cost),
  // The SDK's response type declares `usage` required; a translated Gemini
  // response has none, which is why this normalizer takes an absence and
  // answers null — the request is then unpriced rather than priced at zero.
  usageOf: (res) => usageFromEmbeddings(res.usage),
  cost: computeInputOnlyCost,
  newIdentityId: newEmbeddingsId,
  // No `streaming` block, which is what makes the handler's streaming branch
  // unreachable for this ingress by type rather than by convention: the OpenAI
  // embeddings API has no streaming form to implement. A `stream` a client
  // sends regardless is forwarded like any other undocumented parameter and
  // ignored upstream; the log row records `stream = false` either way.
}
