import { randomUUID } from 'node:crypto'
import type { ChatCompletion, ChatCompletionChunk } from '@/lib/adapters/types'

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
