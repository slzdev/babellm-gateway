import { expect, test } from 'vitest'
import { droppedForChat } from '@/lib/gateway/protocols/dropped'
import type { Candidate } from '@/lib/gateway/resolve'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function candidate(adapter: string, apiFlavor: string): Candidate {
  return {
    provider: { adapter } as Candidate['provider'],
    apiFlavor,
  } as Candidate
}

const req = {
  model: 'v', messages: [{ role: 'user', content: 'hi' }], seed: 7,
} as ChatCompletionRequest

test('a chat_completions candidate forwards the request as sent', () => {
  expect(droppedForChat(candidate('openai', 'chat_completions'), req)).toEqual([])
})

test('an anthropic_messages candidate reports what the Messages API cannot express', () => {
  expect(droppedForChat(candidate('openai_compatible', 'anthropic_messages'), req)).toContain('seed')
})

test('a gemini candidate is judged by its adapter, whatever flavor it carries', () => {
  const dropped = droppedForChat(candidate('gemini', 'anthropic_messages'), {
    ...req, logit_bias: { '1': 1 },
  } as ChatCompletionRequest)
  expect(dropped).toContain('logit_bias')
})
