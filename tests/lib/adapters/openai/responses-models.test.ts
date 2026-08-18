import { expect, test, vi } from 'vitest'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'responses-provider',
  adapter: 'openai_compatible',
  baseUrl: 'https://api.example/v1',
  credentials: { apiKey: 'sk-test' },
  config: {},
}

/** models.list() returns a paginated async-iterable, not a plain array. */
function fakeClient(models: Array<Record<string, unknown>>) {
  const list = vi.fn().mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      for (const model of models) yield model
    },
  })
  const factory = vi.fn().mockReturnValue({ models: { list } })
  return { list, factory }
}

test('lists every model id the provider reports', async () => {
  const { factory } = fakeClient([
    { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
    { id: 'text-embedding-3-small', object: 'model', owned_by: 'openai' },
    { id: 'whisper-1', object: 'model', owned_by: 'openai-internal' },
  ])
  const adapter = createResponsesAdapter(runtime, factory as never)

  const models = await adapter.listModels!({ signal: new AbortController().signal })

  expect(models.map((m) => m.id)).toEqual([
    'gpt-4o', 'text-embedding-3-small', 'whisper-1',
  ])
})

test('reports no fields, because /v1/models carries no metadata', async () => {
  const { factory } = fakeClient([{ id: 'gpt-4o', object: 'model', created: 1 }])
  const adapter = createResponsesAdapter(runtime, factory as never)

  const [model] = await adapter.listModels!({ signal: new AbortController().signal })

  expect(model.fields).toEqual({})
  expect(model.raw).toEqual({ id: 'gpt-4o', object: 'model', created: 1 })
})

test('threads the abort signal into the upstream call', async () => {
  const { list, factory } = fakeClient([])
  const adapter = createResponsesAdapter(runtime, factory as never)
  const signal = new AbortController().signal

  await adapter.listModels!({ signal })

  expect(list).toHaveBeenCalledWith(expect.objectContaining({ signal }))
})

test('an entry with no usable id is skipped rather than stored blank', async () => {
  const { factory } = fakeClient([{ id: 'gpt-4o' }, { object: 'model' }, { id: '' }])
  const adapter = createResponsesAdapter(runtime, factory as never)

  const models = await adapter.listModels!({ signal: new AbortController().signal })
  expect(models.map((m) => m.id)).toEqual(['gpt-4o'])
})
