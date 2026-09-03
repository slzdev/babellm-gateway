import { expect, test, vi } from 'vitest'
import type { AttemptContext, EmbeddingsResult, ProviderAdapter } from '@/lib/adapters/types'
import { classifyProviderError } from '@/lib/gateway/errors'
import { embeddingsIngress as ingress } from '@/lib/gateway/protocols/embeddings'
import { droppedForEmbeddings } from '@/lib/gateway/protocols/dropped'
import type { Candidate } from '@/lib/gateway/resolve'
import type { EmbeddingsRequest } from '@/lib/schemas/embeddings'

function candidate(adapter: string, apiFlavor: string, name = 'acme'): Candidate {
  return { provider: { adapter, name }, apiFlavor } as Candidate
}

const ctx = { upstreamModel: 'text-embedding-3-small' } as AttemptContext
const req = { model: 'house-embed', input: 'hi' } as EmbeddingsRequest

test('has no streaming block, so the handler cannot take the streaming branch', () => {
  // The absence is the encoding of "this dialect has no streaming form" —
  // see Ingress.streaming. A stub here would be unreachable code that reads
  // as reachable.
  expect(ingress.streaming).toBeUndefined()
})

test('an OpenAI-shaped candidate drops nothing, whichever chat flavor it carries', () => {
  // Flavor selects the chat dialect; /embeddings is a sibling of both, so a
  // responses-flavored target is sent the same untouched body.
  const probe = { ...req, user: 'u1' } as EmbeddingsRequest

  expect(droppedForEmbeddings(candidate('openai', 'chat_completions'), probe)).toEqual([])
  expect(droppedForEmbeddings(candidate('openai_compatible', 'responses'), probe)).toEqual([])
})

test('a gemini candidate reports what the translation cannot carry', () => {
  expect(droppedForEmbeddings(candidate('gemini', 'chat_completions'), { ...req, user: 'u1' } as EmbeddingsRequest))
    .toEqual(['user'])
  expect(droppedForEmbeddings(candidate('gemini', 'chat_completions'), req)).toEqual([])
})

test('refuses a target whose adapter cannot embed, naming the provider and its flavor', () => {
  const target = candidate('openai_compatible', 'anthropic_messages', 'clone-co')
  const adapter = {} as ProviderAdapter

  const classified = (() => {
    try {
      void ingress.run(adapter, ctx, req, target)
      throw new Error('expected a refusal')
    } catch (err) {
      return classifyProviderError(err)
    }
  })()

  expect(classified.status).toBe(501)
  expect(classified.code).toBe('unsupported_operation')
  // Non-retryable is the load-bearing half: a target that cannot serve the
  // operation is a misconfiguration, and failing over to a sibling would hide
  // it until the day that sibling is down (spec 3.7).
  expect(classified.retryable).toBe(false)
  expect(classified.message).toContain('clone-co')
  expect(classified.message).toContain('Anthropic Messages')
})

test('delegates to the adapter when it can embed', async () => {
  const result = { object: 'list', model: 'x', data: [] } as unknown as EmbeddingsResult
  const embed = vi.fn().mockResolvedValue(result)

  await expect(ingress.run({ embed } as unknown as ProviderAdapter, ctx, req, candidate('openai', 'chat_completions')))
    .resolves.toBe(result)
  expect(embed).toHaveBeenCalledWith(req, ctx)
})

test('measures zero completion tokens, and nothing at all without upstream usage', () => {
  expect(ingress.usageOf({ usage: { prompt_tokens: 8, total_tokens: 8 } } as EmbeddingsResult))
    .toEqual({ promptTokens: 8, completionTokens: 0, cachedTokens: null, reasoningTokens: null })
  // Gemini's embedContent measures nothing, so the request is unpriced rather
  // than priced at zero.
  expect(ingress.usageOf({} as EmbeddingsResult)).toBeNull()
})

test('finish rewrites the model, attaches the cost, and mints no id', () => {
  const cost = { currency: 'USD' as const, input: '0.000000080', cached: '0.000000000', output: '0.000000000', total: '0.000000080' }
  const res = {
    object: 'list', model: 'text-embedding-3-small',
    data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
    usage: { prompt_tokens: 8, total_tokens: 8 },
  } as unknown as EmbeddingsResult

  const finished = ingress.finish(res, { id: ingress.newIdentityId(), model: 'house-embed' }, cost)

  expect(finished.model).toBe('house-embed')
  expect(finished.usage).toEqual({ prompt_tokens: 8, total_tokens: 8, cost })
  // An embeddings response has no id field, so the identity's id has nowhere
  // to go and must not be invented into one.
  expect(finished).not.toHaveProperty('id')
})

test('an unpriceable response keeps its usage untouched rather than gaining a null cost', () => {
  const res = { object: 'list', model: 'gemini-embedding-001', data: [] } as unknown as EmbeddingsResult

  expect(ingress.finish(res, { id: 'embd_x', model: 'house-embed' }, null))
    .toEqual({ object: 'list', model: 'house-embed', data: [] })
})
