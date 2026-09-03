import { randomUUID } from 'node:crypto'
import type { ChatCompletion, ChatCompletionChunk, EmbeddingsResult } from '@/lib/adapters/types'

export interface IdentityOptions {
  id: string
  model: string
}

export function newCompletionId(): string {
  return `chatcmpl-${randomUUID().replaceAll('-', '')}`
}

export function rewriteCompletion(
  res: ChatCompletion,
  { id, model }: IdentityOptions,
): ChatCompletion {
  return { ...res, id, model }
}

export function rewriteChunk(
  chunk: ChatCompletionChunk,
  { id, model }: IdentityOptions,
): ChatCompletionChunk {
  return { ...chunk, id, model }
}

export function newResponseId(): string {
  return `resp_${randomUUID().replaceAll('-', '')}`
}

/**
 * Rewrites the model, and deliberately NOT the id.
 *
 * /v1/chat/completions replaces the upstream id with a gateway-minted one, but
 * a Responses id is what the client sends back as `previous_response_id`: an id
 * the provider has never seen would break the follow-up. The provider owns the
 * conversation, so the provider owns the id.
 */
export function rewriteResponse<T extends { model?: string }>(
  res: T,
  { model }: IdentityOptions,
): T {
  return { ...res, model }
}

/**
 * An id for a shape that has nowhere to put one.
 *
 * An embeddings response has no `id` field, so `rewriteEmbeddings` cannot
 * write this anywhere and no client ever sees it; the log row keys off the
 * handler's `requestId`, not this. The member exists because one
 * `IdentityOptions` serves all three ingresses, and what this ingress actually
 * needs from it is `model`.
 *
 * Given that, the prefix is the only decision left, and `chatcmpl-` would be
 * the wrong one: an id that never ships is still an id that gets printed in
 * a debugger or a stack trace one day, and naming an embeddings request a chat
 * completion there is a lie with no upside.
 */
export function newEmbeddingsId(): string {
  return `embd_${randomUUID().replaceAll('-', '')}`
}

/**
 * The model, and nothing else — for the third time, and for a third reason.
 *
 * Chat rewrites the id because it mints one; Responses deliberately leaves the
 * provider's id alone (see above). Here there is simply no id in the shape to
 * have an opinion about, which is why this is its own function rather than a
 * call to `rewriteResponse`: that name and its contract are about a decision
 * that has to keep holding for `previous_response_id`, and this is not it.
 */
export function rewriteEmbeddings(
  res: EmbeddingsResult,
  { model }: IdentityOptions,
): EmbeddingsResult {
  return { ...res, model }
}
