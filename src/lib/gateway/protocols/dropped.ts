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
 * `/embeddings` is a sibling of both OpenAI chat dialects rather than one of
 * them, so a `responses`-flavored candidate embeds through the same client a
 * `chat_completions` one does and is sent the request as it arrived. An
 * `anthropic_messages` candidate never reaches this function at all — its
 * adapter has no `embed`, and the ingress's 501 lands first.
 *
 * One gap, deliberate: a `service_tier` the gateway pinned for a Gemini target
 * goes unreported, because the embeddings translator reports only parameters
 * an embeddings request can carry and the OpenAI embeddings API has no tier.
 * Nothing the client sent is being hidden from it.
 */
export function droppedForEmbeddings(
  candidate: Candidate,
  req: EmbeddingsRequest,
): string[] {
  if (candidate.provider.adapter === 'gemini') return geminiEmbeddingsDropped(req)
  return []
}
