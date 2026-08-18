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
  // parallel_tool_calls: false is unmappable for Gemini (chat-to-gemini.ts's
  // UNMAPPABLE list) but not for the Messages API (chat-to-anthropic.ts's
  // toToolChoice folds it into disable_parallel_tool_use), so it can only
  // pass here through the gemini-adapter branch, not the anthropic_messages
  // branch — a flavor-before-adapter ordering bug would fail this.
  const probe = { ...req, parallel_tool_calls: false } as ChatCompletionRequest

  expect(droppedForChat(candidate('gemini', 'anthropic_messages'), probe))
    .toContain('parallel_tool_calls')
  expect(droppedForChat(candidate('openai_compatible', 'anthropic_messages'), probe))
    .not.toContain('parallel_tool_calls')
})
