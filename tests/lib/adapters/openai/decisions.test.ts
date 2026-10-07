import { expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1', name: 'clone', adapter: 'openai_compatible', baseUrl: 'https://api.example/gwt/v1',
  credentials: { apiKey: 'sk-test' }, config: {},
}
const body = { model: 'house-model', input: 'Evidence', questions: [{ type: 'predicate' as const, instructions: 'Damaged?' }], extension: true }
const ctx = { upstreamModel: 'decision-model', signal: new AbortController().signal, requestId: 'req_1' }
const response = { model: 'decision-model', answers: [{ type: 'refusal', name: null }], usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3, compute_units: 7 } }

for (const [flavor, create] of [['chat', createOpenAIAdapter], ['responses', createResponsesAdapter]] as const) {
  test.each([
    [{}, 'https://api.example/gwt/v1/decisions'],
    [{ decisionsPath: '/api/decide' }, 'https://api.example/api/decide'],
  ])(`${flavor} uses the real SDK JSON post and resolved URL: %j`, async (config, expectedUrl) => {
    let sentBody: unknown
    let sentUrl: string | undefined
    const factory = (opts: object) => new OpenAI({
      ...opts, apiKey: 'sk-test', fetch: async (url, init) => {
        sentUrl = String(url)
        sentBody = JSON.parse(init!.body as string)
        return Response.json(response)
      },
    })
    const result = await create({ ...runtime, config }, factory).decide(body, ctx)
    expect(sentUrl).toBe(expectedUrl)
    expect(sentBody).toEqual({ ...body, model: 'decision-model' })
    expect(result).toEqual(response)
  })
}

test('forwards the attempt abort signal to the SDK', async () => {
  const post = vi.fn().mockResolvedValue(response)
  const adapter = createOpenAIAdapter(runtime, () => ({ post }) as unknown as OpenAI)
  await adapter.decide(body, ctx)
  expect(post.mock.calls[0]).toEqual(['/decisions', { body: { ...body, model: 'decision-model' }, signal: ctx.signal }])
})

test.each([[429, true], [400, false], [404, false]])('classifies SDK %i errors for the gateway', async (status, retryable) => {
  const post = vi.fn().mockRejectedValue(new OpenAI.APIError(status, { message: 'bad' }, 'bad', undefined))
  const adapter = createOpenAIAdapter(runtime, () => ({ post }) as unknown as OpenAI)
  await expect(adapter.decide(body, ctx)).rejects.toMatchObject({ status, retryable })
  if (status === 404) await expect(adapter.decide(body, ctx)).rejects.toThrow('decisions path')
})
