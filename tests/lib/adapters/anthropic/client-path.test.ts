import { expect, test } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'

/**
 * The whole path design rests on the SDK honouring a per-request `path`, as
 * the OpenAI SDK does. This test is the proof, and it stays as the regression
 * that would catch an SDK upgrade taking the option away.
 */
test('a per-request path replaces the SDK default and joins onto the base URL', async () => {
  const seen: string[] = []
  const fetchStub: typeof fetch = async (input) => {
    seen.push(typeof input === 'string' ? input : String((input as Request).url))
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const client = new Anthropic({
    apiKey: 'sk-test',
    baseURL: 'https://upstream.test/v1',
    fetch: fetchStub,
    maxRetries: 0,
  })

  await client.messages.create(
    { model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    { path: '/messages' } as never,
  )

  expect(seen).toEqual(['https://upstream.test/v1/messages'])
})
