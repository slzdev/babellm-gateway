import { expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import { withRespondViaChat } from '@/lib/adapters/wrappers'
import type { EmbeddingsRequest } from '@/lib/schemas/embeddings'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'openai-prod',
  adapter: 'openai',
  baseUrl: null,
  credentials: { apiKey: 'sk-test' },
  config: {},
}

const ctx = {
  upstreamModel: 'text-embedding-3-small',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const body: EmbeddingsRequest = { model: 'house-embed', input: ['hello', 'world'] }

const response = {
  object: 'list',
  model: 'text-embedding-3-small',
  data: [
    { object: 'embedding', index: 0, embedding: [0.01, -0.02] },
    { object: 'embedding', index: 1, embedding: [0.03, -0.04] },
  ],
  usage: { prompt_tokens: 4, total_tokens: 4 },
}

function fakeClient(create = vi.fn().mockResolvedValue(response)) {
  return { create, factory: vi.fn().mockReturnValue({ embeddings: { create } }) }
}

/**
 * `OpenAI.APIError`'s constructor is `(status, error, message, headers)`,
 * where `error` is the already-unwrapped body — the same helper the errors
 * test uses.
 */
function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

test('substitutes the upstream model name', async () => {
  const { create, factory } = fakeClient()
  await createOpenAIAdapter(runtime, factory as never).embed!(body, ctx)

  expect(create.mock.calls[0][0].model).toBe('text-embedding-3-small')
})

test('returns the upstream body as it arrived', async () => {
  const { factory } = fakeClient()
  const result = await createOpenAIAdapter(runtime, factory as never).embed!(body, ctx)

  expect(result).toEqual(response)
})

/**
 * The one thing in this file that is not a passthrough assertion. The SDK
 * treats an absent `encoding_format` as licence to request base64 upstream and
 * decode the reply into a Float32Array, which serialises as {"0":0.1,…} — an
 * object, not an array, and unreadable by every OpenAI client. Sending the
 * parameter explicitly is what keeps the SDK out of the response body, so
 * these two cases fail the moment the line is dropped or made conditional.
 */
test('sends an explicit float encoding_format when the client sent none', async () => {
  const { create, factory } = fakeClient()
  await createOpenAIAdapter(runtime, factory as never).embed!(body, ctx)

  expect(create.mock.calls[0][0].encoding_format).toBe('float')
})

test('sends an encoding_format the SDK will see as caller-provided, always', async () => {
  const { create, factory } = fakeClient()
  const adapter = createOpenAIAdapter(runtime, factory as never)

  for (const encoding_format of [undefined, 'float', 'base64'] as const) {
    await adapter.embed!({ ...body, ...(encoding_format ? { encoding_format } : {}) }, ctx)
  }

  // `!!body.encoding_format` is the SDK's own test for whether it may rewrite
  // the request and the response; every call must pass it.
  for (const call of create.mock.calls) expect(!!call[0].encoding_format).toBe(true)
})

test('passes a base64 request through rather than substituting float', async () => {
  const { create, factory } = fakeClient()
  await createOpenAIAdapter(runtime, factory as never)
    .embed!({ ...body, encoding_format: 'base64' }, ctx)

  expect(create.mock.calls[0][0].encoding_format).toBe('base64')
})

test('forwards dimensions and user', async () => {
  const { create, factory } = fakeClient()
  await createOpenAIAdapter(runtime, factory as never)
    .embed!({ ...body, dimensions: 512, user: 'u-1' }, ctx)

  expect(create.mock.calls[0][0]).toMatchObject({ dimensions: 512, user: 'u-1' })
})

test('forwards unknown provider parameters untouched', async () => {
  const { create, factory } = fakeClient()
  await createOpenAIAdapter(runtime, factory as never)
    .embed!({ ...body, truncate: 'END' } as never, ctx)

  expect(create.mock.calls[0][0].truncate).toBe('END')
})

test('forwards a token-array input as it arrived', async () => {
  const { create, factory } = fakeClient()
  await createOpenAIAdapter(runtime, factory as never).embed!(
    { model: 'house-embed', input: [[1, 2], [3, 4]] },
    ctx,
  )

  expect(create.mock.calls[0][0].input).toEqual([[1, 2], [3, 4]])
})

test('sends the embeddings path and the abort signal', async () => {
  const { create, factory } = fakeClient()
  await createOpenAIAdapter(runtime, factory as never).embed!(body, ctx)

  expect(create.mock.calls[0][1]).toMatchObject({ path: '/embeddings', signal: ctx.signal })
})

/**
 * Flavor selects the chat dialect; embeddings are a sibling endpoint, so a
 * Responses-flavored model embeds through the same client and the same path.
 */
test('a Responses-flavored provider embeds through the same client', async () => {
  const { create, factory } = fakeClient()
  const rt = { ...runtime, adapter: 'openai_compatible' as const, baseUrl: 'https://api.example/v1' }
  const result = await createResponsesAdapter(rt, factory as never).embed!(body, ctx)

  expect(result).toEqual(response)
  expect(create.mock.calls[0][0].encoding_format).toBe('float')
  expect(create.mock.calls[0][1]).toMatchObject({ path: '/embeddings' })
})

/**
 * The chat adapter is only ever reached through this wrapper (registry.ts),
 * so an `embed` that the spread failed to carry would be invisible here and
 * a 501 in production.
 */
test('embed survives withRespondViaChat', async () => {
  const { create, factory } = fakeClient()
  const wrapped = withRespondViaChat(
    createOpenAIAdapter(runtime, factory as never),
    runtime.name,
  )

  expect(typeof wrapped.embed).toBe('function')
  await wrapped.embed!(body, ctx)
  expect(create).toHaveBeenCalledTimes(1)
})

test('a 429 is retryable so the next target gets a turn', async () => {
  const { factory } = fakeClient(vi.fn().mockRejectedValue(apiError(429, 'slow down')))
  const adapter = createOpenAIAdapter(runtime, factory as never)

  await expect(adapter.embed!(body, ctx)).rejects.toMatchObject({
    status: 429,
    retryable: true,
  })
})

test('a 400 is not retryable — another provider would reject it too', async () => {
  const { factory } = fakeClient(vi.fn().mockRejectedValue(apiError(400, 'bad input')))
  const adapter = createOpenAIAdapter(runtime, factory as never)

  await expect(adapter.embed!(body, ctx)).rejects.toMatchObject({
    status: 400,
    retryable: false,
  })
})

/**
 * A 404 on this endpoint says the endpoint is missing, which for the chat
 * adapters is evidence about the flavor. Here it is not — `/embeddings` is a
 * sibling of both chat dialects — so the hint must point at the path instead.
 */
test('a 404 is explained by the path, not by the API flavor', async () => {
  const { factory } = fakeClient(vi.fn().mockRejectedValue(apiError(404, 'Not Found')))
  const adapter = createOpenAIAdapter(runtime, factory as never)

  try {
    await adapter.embed!(body, ctx)
    expect.unreachable('a 404 must reject')
  } catch (err) {
    const { message } = err as Error
    expect(message).toContain('embeddings path')
    expect(message).not.toContain('API flavor')
  }
})
