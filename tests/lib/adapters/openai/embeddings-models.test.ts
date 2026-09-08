import { describe, expect, test, vi } from 'vitest'
import { createOpenAIAdapter } from '@/lib/adapters/openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderConfig, ProviderRuntime } from '@/lib/adapters/types'

/**
 * OpenRouter's `/models` omits its embeddings models and serves them from
 * `/embeddings/models`, so discovery asks for both. The path is asked for
 * unconditionally — no provider detection anywhere — which is why the tests
 * below pin the two ways that has to stay safe: a provider that has no such
 * endpoint must sync exactly as before, and a provider whose router answers
 * the path with its whole catalog must not have that catalog relabelled.
 */

const base: ProviderRuntime = {
  id: 'p1',
  name: 'openrouter',
  adapter: 'openai_compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  credentials: { apiKey: 'sk-test' },
  config: {},
}

function runtime(config: ProviderConfig = {}) {
  return { ...base, config }
}

const signal = new AbortController().signal

/**
 * `models.list()` returns a fresh paginated async-iterable per call, and this
 * suite calls it twice — one canned iterable would be drained by the first.
 * Keyed by the `path` the adapter asks for; a path with no entry rejects the
 * way an endpoint that does not exist does.
 */
function fakeClient(listings: Record<string, Array<Record<string, unknown>>>) {
  const list = vi.fn().mockImplementation(async ({ path }: { path: string }) => {
    const models = listings[path]
    if (!models) throw Object.assign(new Error(`404 no such endpoint: ${path}`), { status: 404 })
    return {
      async *[Symbol.asyncIterator]() {
        for (const model of models) yield model
      },
    }
  })
  return { list, factory: vi.fn().mockReturnValue({ models: { list } }) }
}

describe('a provider that splits its listing', () => {
  const listings = {
    '/models': [{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-opus-4.6' }],
    '/embeddings/models': [
      { id: 'openai/text-embedding-3-small' },
      { id: 'google/gemini-embedding-001' },
    ],
  }

  test('adds the models the main listing never mentioned', async () => {
    const { factory } = fakeClient(listings)
    const adapter = createOpenAIAdapter(runtime(), factory as never)

    const models = await adapter.listModels!({ signal })

    expect(models.map((m) => m.id)).toEqual([
      'openai/gpt-4o',
      'anthropic/claude-opus-4.6',
      'openai/text-embedding-3-small',
      'google/gemini-embedding-001',
    ])
  })

  test('tags them as embedding models, because the endpoint says so', async () => {
    const { factory } = fakeClient(listings)
    const adapter = createOpenAIAdapter(runtime(), factory as never)

    const models = await adapter.listModels!({ signal })
    const byId = new Map(models.map((m) => [m.id, m]))

    expect(byId.get('google/gemini-embedding-001')!.fields).toEqual({ kind: 'embedding' })
    // Unchanged: the main listing carries no metadata, and none is invented.
    expect(byId.get('openai/gpt-4o')!.fields).toEqual({})
  })

  test('keeps the provider\'s raw entry for the added models too', async () => {
    const { factory } = fakeClient(listings)
    const adapter = createOpenAIAdapter(runtime(), factory as never)

    const models = await adapter.listModels!({ signal })

    expect(models.at(-1)!.raw).toEqual({ id: 'google/gemini-embedding-001' })
  })

  test('asks for the sibling of wherever the provider lists its models', async () => {
    const { list, factory } = fakeClient({
      'https://openrouter.ai/api/v1/models': [{ id: 'openai/gpt-4o' }],
      'https://openrouter.ai/api/v1/embeddings/models': [{ id: 'openai/text-embedding-3-small' }],
    })
    const adapter = createOpenAIAdapter(
      runtime({ modelsPath: '/api/v1/models' }), factory as never,
    )

    const models = await adapter.listModels!({ signal })

    expect(list.mock.calls.map(([opts]) => opts.path)).toEqual([
      'https://openrouter.ai/api/v1/models',
      'https://openrouter.ai/api/v1/embeddings/models',
    ])
    expect(models.map((m) => m.id)).toEqual(['openai/gpt-4o', 'openai/text-embedding-3-small'])
  })

  test('threads the discovery signal into the second listing as well', async () => {
    const { list, factory } = fakeClient(listings)
    await createOpenAIAdapter(runtime(), factory as never).listModels!({ signal })

    expect(list.mock.calls[1][0]).toMatchObject({ path: '/embeddings/models', signal })
  })

  test('discovers the same way for a Responses provider', async () => {
    const { factory } = fakeClient(listings)
    const adapter = createResponsesAdapter(runtime(), factory as never)

    const models = await adapter.listModels!({ signal })

    expect(models.map((m) => m.id)).toContain('openai/text-embedding-3-small')
  })
})

describe('a provider that does not split its listing', () => {
  test('syncs on the main listing alone when the sibling 404s', async () => {
    const { factory } = fakeClient({ '/models': [{ id: 'llama-3.3-70b' }] })
    const adapter = createOpenAIAdapter(runtime(), factory as never)

    const models = await adapter.listModels!({ signal })

    expect(models).toEqual([{ id: 'llama-3.3-70b', fields: {}, raw: { id: 'llama-3.3-70b' } }])
  })

  test('still fails the sync when the main listing itself fails', async () => {
    const { factory } = fakeClient({ '/embeddings/models': [{ id: 'nope' }] })
    const adapter = createOpenAIAdapter(runtime(), factory as never)

    await expect(adapter.listModels!({ signal })).rejects.toThrow(/no such endpoint/)
  })

  /**
   * The mislabelling this design has to survive: a permissive router that
   * answers any `/models`-ish path with the whole catalog. Every model comes
   * back already known, so nothing is added and nothing is retagged — a chat
   * model called an embedding model would break routing, which trusts `kind`.
   */
  test('leaves a catch-all router\'s echo of the main listing alone', async () => {
    const catalog = [{ id: 'openai/gpt-4o' }, { id: 'openai/text-embedding-3-small' }]
    const { factory } = fakeClient({ '/models': catalog, '/embeddings/models': catalog })
    const adapter = createOpenAIAdapter(runtime(), factory as never)

    const models = await adapter.listModels!({ signal })

    expect(models.map((m) => m.id)).toEqual(['openai/gpt-4o', 'openai/text-embedding-3-small'])
    expect(models.map((m) => m.fields)).toEqual([{}, {}])
  })

  test('a repeated id in the sibling listing is added once', async () => {
    const { factory } = fakeClient({
      '/models': [{ id: 'openai/gpt-4o' }],
      '/embeddings/models': [{ id: 'bge-m3' }, { id: 'bge-m3' }],
    })
    const adapter = createOpenAIAdapter(runtime(), factory as never)

    const models = await adapter.listModels!({ signal })

    expect(models.map((m) => m.id)).toEqual(['openai/gpt-4o', 'bge-m3'])
  })

  test('an entry with no usable id is skipped in the sibling listing too', async () => {
    const { factory } = fakeClient({
      '/models': [{ id: 'openai/gpt-4o' }],
      '/embeddings/models': [{ object: 'model' }, { id: '' }, { id: 'bge-m3' }],
    })
    const adapter = createOpenAIAdapter(runtime(), factory as never)

    const models = await adapter.listModels!({ signal })

    expect(models.map((m) => m.id)).toEqual(['openai/gpt-4o', 'bge-m3'])
  })

  /**
   * The first-party OpenAI lists text-embedding-3-* in `/models` like
   * everything else, so the second request would be pure waste.
   */
  test('the first-party OpenAI is asked for one listing only', async () => {
    const { list, factory } = fakeClient({ '/models': [{ id: 'gpt-4o' }] })
    const rt: ProviderRuntime = {
      ...base, name: 'openai-prod', adapter: 'openai', baseUrl: null,
    }
    const adapter = createOpenAIAdapter(rt, factory as never)

    const models = await adapter.listModels!({ signal })

    expect(list).toHaveBeenCalledTimes(1)
    expect(models.map((m) => m.id)).toEqual(['gpt-4o'])
  })
})
