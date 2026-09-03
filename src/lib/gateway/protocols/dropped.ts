import { droppedParams as anthropicDropped } from '@/lib/translate/chat-to-anthropic'
import { droppedParams as geminiDropped } from '@/lib/translate/chat-to-gemini'
import { droppedParams as responsesDropped } from '@/lib/translate/chat-to-responses'
import { droppedParams as geminiEmbeddingsDropped } from '@/lib/translate/embeddings-to-gemini'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type { EmbeddingsRequest } from '@/lib/schemas/embeddings'
import type { Candidate } from '../resolve'

/**
 * What one candidate cannot express of a Chat Completions request.
 *
 * One function rather than a conditional per ingress: both chat-shaped
 * ingresses reduce to this question, the adapter check has to come before the
 * flavor check (Gemini's adapter translates regardless of flavor, having no
 * native endpoint to be native on), and duplicating that ordering is how it
 * gets broken.
 */
export function droppedForChat(candidate: Candidate, req: ChatCompletionRequest): string[] {
  if (candidate.provider.adapter === 'gemini') return geminiDropped(req)
  if (candidate.apiFlavor === 'responses') return responsesDropped(req)
  if (candidate.apiFlavor === 'anthropic_messages') return anthropicDropped(req)
  // A chat_completions candidate is sent the request as it arrived, so there
  // is nothing it can fail to express.
  return []
}

/**
 * What one candidate cannot express of an embeddings request.
 *
 * Here rather than in the ingress so this file keeps answering the whole of
 * the question it is named for — "what can this candidate not express" — for
 * every wire shape the gateway serves, and so the adapter-first ordering above
 * is read from one place rather than restated per dialect.
 *
 * Flavor is not a lever on this shape, which is the whole of the difference:
 * `/embeddings` is a sibling of all three chat dialects rather than one of
 * them, so a `responses`-flavored candidate embeds through the same client a
 * `chat_completions` one does and is sent the request as it arrived. An
 * `anthropic_messages` candidate is normally steered away before selection by
 * the ingress's `supports`, and answers `withEmbedUnsupported`'s 501 when it
 * is the only candidate there is — either way it never serves a request whose
 * dropped set is worth asking about.
 *
 * A pinned `service_tier` is reported, and this is the one thing the candidate
 * contributes beyond its adapter. The ingress declares no `bodyFor`, so an
 * operator's pin is never injected into a dialect that has no such parameter —
 * and a routing decision the gateway cannot honour is exactly what this header
 * exists to surface, rather than leaving it to be inferred from latency that
 * never changed. The transcription ingress carries the same clause for the
 * same reason.
 *
 * De-duplicated because both halves can name that one parameter: the schema is
 * loose, so a `service_tier` a *client* sent is forwarded and then reported by
 * the Gemini translator under the ordinary drop-and-report rule. A request
 * carrying both a client's tier and an operator's pin has one parameter that
 * did nothing, so it reads one name, once.
 */
export function droppedForEmbeddings(
  candidate: Candidate,
  req: EmbeddingsRequest,
): string[] {
  const dropped = candidate.provider.adapter === 'gemini' ? geminiEmbeddingsDropped(req) : []
  if (!candidate.serviceTier) return dropped
  return [...new Set([...dropped, 'service_tier'])]
}
