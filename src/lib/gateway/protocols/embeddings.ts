import type { EmbeddingsResult } from '@/lib/adapters/types'
import { computeInputOnlyCost } from '@/lib/pricing'
import { embeddingsRequestSchema, type EmbeddingsRequest } from '@/lib/schemas/embeddings'
import { isTextInput } from '@/lib/translate/embeddings-to-gemini'
import { withUsageCost } from '../cost'
import { parseWith, readJson, type Ingress } from '../handler'
import { rewriteEmbeddings } from '../identity'
import type { Candidate } from '../resolve'
import { usageFromEmbeddings } from '../usage'
import { droppedForEmbeddings } from './dropped'

/**
 * `POST /v1/embeddings`, as an `Ingress`.
 *
 * The fourth dialect on the shared handler, and the plainest: JSON in, JSON
 * out, like the two chat shapes, but with no streaming form, no response id,
 * and no `service_tier` — three optional seams left unimplemented rather than
 * stubbed. Everything else about the request (auth, tags, limits, routing,
 * failover, the breaker, pricing, logging) is the handler's, unchanged.
 */

/**
 * Whether this candidate can serve *this* request.
 *
 * The adapter is checked before the flavor, mirroring `createAdapter` and the
 * transcription ingress: a gemini-adapter provider gets the translated `embed`
 * regardless of the flavor label it carries, so a flavor-first ordering here
 * would call such a target unable to embed at all. `withEmbedUnsupported` is
 * applied only inside `flavoredAdapter`, i.e. never to Gemini.
 *
 * Judged per request rather than per target because one of the two rules is a
 * property of the request: `input` may be an array of token ids, which Gemini
 * cannot accept — it embeds text. That is knowable from the request alone,
 * which is the test for what belongs here, and knowing it before ordering is
 * what makes the answer deterministic. Discovered at attempt time instead, a
 * token-array request against a mixed Gemini+OpenAI model under `round_robin`
 * would succeed about half the time and answer a 400 the rest; filtering the
 * Gemini candidate out steers it to the target that takes tokens and leaves
 * that target eligible for every request it does serve.
 *
 * Both rules have the matching refusal `supports`'s docblock requires, which
 * is what licenses them: `withEmbedUnsupported` answers the Anthropic flavor
 * with a 501, and the translator's `refuseTokenInput` answers token ids with a
 * 400 naming `input` and the remedy. Neither makes an upstream call, so the
 * all-ineligible fallback costs nothing.
 */
function supports(candidate: Candidate, req: EmbeddingsRequest): boolean {
  if (candidate.provider.adapter === 'gemini') return isTextInput(req.input)
  // Anthropic's API has no embeddings endpoint, and nothing can synthesize a
  // vector out of the completion it does serve — so this target could only
  // burn an attempt, a breaker failure and a round trip to report something
  // the gateway already knew from its own configuration.
  if (candidate.apiFlavor === 'anthropic_messages') return false
  return true
}

export const embeddingsIngress: Ingress<EmbeddingsRequest, EmbeddingsResult, never> = {
  read: async (request) => parseWith(embeddingsRequestSchema, await readJson(request)),
  modelOf: (req) => req.model,
  // Never, and unlike transcription this ingress does not even refuse
  // `stream: true`: the OpenAI embeddings API documents no such parameter, so
  // one a client sends anyway is forwarded like any other undocumented field
  // and ignored by an OpenAI-shaped upstream. Declaring none of the streaming
  // members is what makes the handler's streaming branch unreachable here.
  isStream: () => false,
  supports,
  // No `bodyFor`: the embeddings dialect has no `service_tier` field, and
  // OpenAI answers an argument it does not recognise with `400 Unrecognized
  // request argument supplied` rather than ignoring it. A 400 is
  // non-retryable, so injecting an operator's pinned tier here would take
  // every embeddings request to that target off the air, blaming an argument
  // the client never sent. The pin is reported as dropped instead — see
  // `droppedForEmbeddings`.
  droppedFor: (candidate, req) => droppedForEmbeddings(candidate, req),
  run: (adapter, ctx, req) => adapter.embed(req, ctx),
  // The SDK's response type declares `usage` required; a translated Gemini
  // response has none, which is why this normalizer takes an absence and
  // answers null — the request is then unpriced rather than priced at zero.
  usageOf: (res) => usageFromEmbeddings(res.usage),
  cost: computeInputOnlyCost,
  finish: (res, identity, cost) => withUsageCost(rewriteEmbeddings(res, identity), cost),
  toResponse: (res, headers) => Response.json(res, { headers }),
  // No `newIdentityId`: an embeddings response has no `id` field, so there is
  // nothing to mint one for and the handler's `''` is never read. `finish`
  // still rewrites the `model`, which this shape does carry.
}
