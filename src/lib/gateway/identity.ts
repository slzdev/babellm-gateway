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
