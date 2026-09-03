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
 * The model, and nothing else — for a third time, and for a third reason.
 *
 * Chat rewrites the id because it mints one; Responses deliberately leaves the
 * provider's id alone (see above). Here there is simply no id in the shape to
 * have an opinion about, which the embeddings ingress says by declaring no
 * `newIdentityId` at all.
 *
 * Its own function rather than a call to `rewriteResponse`, whose body this
 * duplicates: that function's name and docblock are about a decision that has
 * to keep holding for `previous_response_id`, and sharing it would make that
 * docblock false for one of its two callers. The file already keeps
 * `rewriteCompletion` and `rewriteChunk` apart on the same grounds — one
 * rewriter per shape, so each can say what its shape's rule is.
 */
export function rewriteEmbeddings(
  res: EmbeddingsResult,
  { model }: IdentityOptions,
): EmbeddingsResult {
  return { ...res, model }
}
