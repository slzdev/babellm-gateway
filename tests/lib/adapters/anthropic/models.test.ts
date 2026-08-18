import { expect, test, vi } from 'vitest'
import { listModels } from '@/lib/adapters/anthropic/client'

test('listModels reports ids and whatever limits the endpoint states', async () => {
  const page = [
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', max_input_tokens: 1000000, max_tokens: 128000 },
    { id: '', display_name: 'nameless' },
    { id: 'claude-haiku-4-5' },
  ]
  const client = {
    models: { list: vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () { yield* page } }) },
  }

  const models = await listModels(client as never, { signal: new AbortController().signal }, '/models')

  expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-haiku-4-5'])
  expect(models[0].fields).toEqual({ contextWindow: 1000000, maxOutputTokens: 128000 })
  expect(models[1].fields).toEqual({})
  expect(client.models.list).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ path: '/models' }),
  )
})
