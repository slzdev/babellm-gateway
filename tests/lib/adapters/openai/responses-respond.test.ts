import { expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'

function runtime() {
  return {
    id: 'p1', name: 'p', adapter: 'openai' as const, baseUrl: null,
    credentials: { apiKey: 'sk-x' }, config: {},
  }
}

const ctx = { upstreamModel: 'gpt-5', signal: new AbortController().signal, requestId: 'r1' }

test('respond forwards the request untouched except for the model', async () => {
  const create = vi.fn().mockResolvedValue({ id: 'resp_up', object: 'response', output: [] })
  const adapter = createResponsesAdapter(runtime(), () => ({ responses: { create } }) as never)

  await adapter.respond!(
    { model: 'virtual', input: 'hi', tools: [{ type: 'web_search' }] },
    ctx,
  )

  // Passthrough means passthrough: the hosted tool survives, and only the
  // model is swapped for the target's upstream name.
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'gpt-5', input: 'hi', tools: [{ type: 'web_search' }], stream: false }),
    expect.objectContaining({ path: '/responses' }),
  )
})

test('respond wraps an SDK failure as a ProviderError', async () => {
  const create = vi.fn().mockRejectedValue(new OpenAI.APIError(429, { message: 'slow down' }, 'slow down', undefined))
  const adapter = createResponsesAdapter(runtime(), () => ({ responses: { create } }) as never)

  await expect(adapter.respond!({ model: 'm', input: 'hi' }, ctx)).rejects.toMatchObject({
    name: 'ProviderError', status: 429, retryable: true,
  })
})

test('respondStream yields upstream events unchanged', async () => {
  const create = vi.fn().mockResolvedValue((async function* () {
    yield { type: 'response.created', sequence_number: 0 }
    yield { type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' }
  })())
  const adapter = createResponsesAdapter(runtime(), () => ({ responses: { create } }) as never)

  const events = []
  for await (const event of adapter.respondStream!({ model: 'm', input: 'hi', stream: true }, ctx)) {
    events.push(event)
  }

  expect(events.map((e) => e.type)).toEqual(['response.created', 'response.output_text.delta'])
})
