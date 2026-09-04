import { expect, test, vi } from 'vitest'
import type { AttemptContext, EmbeddingsResult, ProviderAdapter } from '@/lib/adapters/types'
import { embeddingsIngress as ingress } from '@/lib/gateway/protocols/embeddings'
import type { Candidate } from '@/lib/gateway/resolve'
import type { EmbeddingsRequest } from '@/lib/schemas/embeddings'

function candidate(adapter: string, apiFlavor: string): Candidate {
  return {
    provider: { adapter, name: adapter } as Candidate['provider'],
    apiFlavor,
  } as Candidate
}

/** The same candidate with a service tier pinned on its target. */
function tiered(adapter: string, apiFlavor: string): Candidate {
  return { ...candidate(adapter, apiFlavor), serviceTier: 'priority' } as Candidate
}

function request(body: unknown): Request {
  return new Request('http://gateway.test/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function req(overrides: Partial<EmbeddingsRequest> = {}): EmbeddingsRequest {
  return { model: 'house-embed', input: 'hi', ...overrides } as EmbeddingsRequest
}

const identity = { id: '', model: 'house-embed' }
const cost = {
  currency: 'USD' as const, input: '0.000000080', cached: '0.000000000',
  output: '0.000000000', total: '0.000000080',
}

// --- read ------------------------------------------------------------------

test('reads and validates a JSON body', async () => {
  const parsed = await ingress.read(request({
    model: 'house-embed', input: ['a', 'b'], dimensions: 512, encoding_format: 'base64',
  }))

  expect(parsed.model).toBe('house-embed')
  expect(parsed.input).toEqual(['a', 'b'])
  expect(parsed.dimensions).toBe(512)
  expect(parsed.encoding_format).toBe('base64')
})

test('forwards a stream flag as the undocumented parameter it is', async () => {
  // Unlike transcription, which refuses `stream: true` outright: the OpenAI
  // embeddings API documents no such parameter, so one a client sends is
  // forwarded like any other unknown field and ignored upstream. What must
  // stay true is that it can never route this request into the streaming
  // branch — see `isStream` below.
  const parsed = await ingress.read(request({ model: 'house-embed', input: 'hi', stream: true }))

  expect(parsed.stream).toBe(true)
  expect(ingress.isStream(parsed)).toBe(false)
})

// --- the one-liners --------------------------------------------------------

test('names the model and never streams', () => {
  expect(ingress.modelOf(req({ model: 'text-embedding-3-large' }))).toBe('text-embedding-3-large')
  expect(ingress.isStream(req())).toBe(false)
})

test('declares none of the streaming members, so the streaming branch is unreachable', () => {
  // The absence, not a false-returning predicate, is what makes it
  // unreachable by type — and `assertStreamable` in the handler is what turns
  // a dialect that got `isStream` wrong into an error instead of a crash
  // inside the SSE relay.
  expect(ingress.runStream).toBeUndefined()
  expect(ingress.stream).toBeUndefined()
  expect(ingress.captureResponse).toBeUndefined()
})

test('mints no response id, because the shape has nowhere to put one', () => {
  expect(ingress.newIdentityId).toBeUndefined()
})

test('runs the adapter embedding', async () => {
  const result = { object: 'list', model: 'x', data: [] } as unknown as EmbeddingsResult
  const embed = vi.fn().mockResolvedValue(result)
  const body = req()
  const ctx = {} as AttemptContext

  await expect(ingress.run({ embed } as unknown as ProviderAdapter, ctx, body)).resolves.toBe(result)
  expect(embed).toHaveBeenCalledWith(body, ctx)
})

// --- supports --------------------------------------------------------------

test('an anthropic_messages candidate never embeds, whatever the input', () => {
  const anthropic = candidate('openai_compatible', 'anthropic_messages')

  expect(ingress.supports?.(anthropic, req())).toBe(false)
  expect(ingress.supports?.(anthropic, req({ input: ['a', 'b'] }))).toBe(false)
  expect(ingress.supports?.(anthropic, req({ input: [1, 2, 3] }))).toBe(false)
})

test('a Gemini candidate serves text but not token ids', () => {
  const gemini = candidate('gemini', 'chat_completions')

  expect(ingress.supports?.(gemini, req({ input: 'hi' }))).toBe(true)
  expect(ingress.supports?.(gemini, req({ input: ['a', 'b'] }))).toBe(true)
  // Knowable from the request alone, which is the test for what belongs in
  // `supports`: judged at attempt time instead, the same request against a
  // mixed model would succeed or answer a 400 depending on which target
  // selection happened to pick.
  expect(ingress.supports?.(gemini, req({ input: [1, 2, 3] }))).toBe(false)
  expect(ingress.supports?.(gemini, req({ input: [[1, 2], [3]] }))).toBe(false)
})

test('a Gemini candidate is judged by its adapter, whatever flavor it carries', () => {
  // The registry gives every gemini-adapter provider the translated `embed`,
  // ignoring the flavor label entirely — so a flavor-first ordering here
  // would call this candidate unable to embed at all.
  const gemini = candidate('gemini', 'anthropic_messages')

  expect(ingress.supports?.(gemini, req())).toBe(true)
  expect(ingress.supports?.(gemini, req({ input: [1, 2] }))).toBe(false)
})

test('OpenAI-shaped candidates serve every input shape', () => {
  for (const adapter of ['openai', 'openai_compatible']) {
    for (const flavor of ['chat_completions', 'responses']) {
      for (const input of ['hi', ['a', 'b'], [1, 2, 3], [[1, 2], [3]]]) {
        expect(ingress.supports?.(
          candidate(adapter, flavor),
          req({ input: input as EmbeddingsRequest['input'] }),
        )).toBe(true)
      }
    }
  }
})

// --- droppedFor ------------------------------------------------------------

test('an OpenAI-shaped target drops nothing, whichever chat flavor it carries', () => {
  // Flavor selects the chat dialect; /embeddings is a sibling of all three, so
  // a responses-flavored target is sent the same untouched body.
  expect(ingress.droppedFor(candidate('openai', 'chat_completions'), req({ user: 'u1' }))).toEqual([])
  expect(ingress.droppedFor(candidate('openai_compatible', 'responses'), req({ user: 'u1' }))).toEqual([])
})

test('reports what a Gemini target cannot express', () => {
  expect(ingress.droppedFor(candidate('gemini', 'chat_completions'), req({ user: 'u1' })))
    .toEqual(['user'])
  expect(ingress.droppedFor(candidate('gemini', 'chat_completions'), req())).toEqual([])
})

test('reports a pinned service tier as dropped, whatever the target', () => {
  // This dialect has no `service_tier` field, so a tier the operator pinned on
  // the target cannot be honoured — and an operator's routing decision the
  // gateway silently ignores is exactly what this header exists to surface.
  expect(ingress.droppedFor(tiered('openai', 'chat_completions'), req()))
    .toEqual(['service_tier'])
  // The translator's own drops first, the pin appended — the same order the
  // transcription ingress produces, because both build the list the same way.
  expect(ingress.droppedFor(tiered('gemini', 'chat_completions'), req({ user: 'u1' })))
    .toEqual(['user', 'service_tier'])
})

test('names a service tier once when both the client and the operator sent one', () => {
  // The schema is loose, so a client-sent tier is forwarded and reported by
  // the Gemini translator; the operator's pin is reported by the ingress. One
  // parameter did nothing, so the header names it once.
  expect(ingress.droppedFor(
    tiered('gemini', 'chat_completions'),
    { ...req(), service_tier: 'flex' } as EmbeddingsRequest,
  )).toEqual(['service_tier'])
})

test('injects nothing per target, so no tier reaches the upstream body', () => {
  // No `bodyFor` at all: the handler's default hands the client's own request
  // to every candidate. A `service_tier` added here would travel as an
  // argument OpenAI does not recognise, and it answers those with a
  // non-retryable 400 rather than ignoring them — every embeddings request to
  // that target failed by a routing setting with no meaning on this endpoint.
  expect(ingress.bodyFor).toBeUndefined()
})

// --- usageOf and cost ------------------------------------------------------

test('measures zero completion tokens, and nothing at all without upstream usage', () => {
  expect(ingress.usageOf({ usage: { prompt_tokens: 8, total_tokens: 8 } } as EmbeddingsResult))
    .toEqual({ promptTokens: 8, completionTokens: 0, cachedTokens: null, reasoningTokens: null })
  // Gemini's embedContent measures nothing, so the request is unpriced rather
  // than priced at zero.
  expect(ingress.usageOf({} as EmbeddingsResult)).toBeNull()
})

test('prices on input alone, so a catalog row with no output rate still bills', () => {
  // The chat rule would call this unpriced: `computeCost` requires an output
  // rate, and an embedding model routinely has none because there is no
  // output to charge for.
  const cost = ingress.cost(
    { inputPerMtok: '0.020000000', cachedInputPerMtok: null, outputPerMtok: null },
    { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: null, reasoningTokens: null },
  )

  expect(cost?.totalUsd).toBe('0.020000000')
  expect(cost?.outputUsd).toBe('0.000000000')
})

// --- finish ----------------------------------------------------------------

test('finish rewrites the model, attaches the cost, and invents no id', () => {
  const res = {
    object: 'list', model: 'text-embedding-3-small',
    data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
    usage: { prompt_tokens: 8, total_tokens: 8 },
  } as unknown as EmbeddingsResult

  const finished = ingress.finish(res, identity, cost)

  expect(finished.model).toBe('house-embed')
  expect(finished.usage).toEqual({ prompt_tokens: 8, total_tokens: 8, cost })
  // The handler hands this dialect `id: ''`, which nothing may write anywhere:
  // an embeddings response has no id field to put one in.
  expect(finished).not.toHaveProperty('id')
})

test('an unpriceable response keeps its usage untouched rather than gaining a null cost', () => {
  const res = { object: 'list', model: 'gemini-embedding-001', data: [] } as unknown as EmbeddingsResult

  expect(ingress.finish(res, identity, null))
    .toEqual({ object: 'list', model: 'house-embed', data: [] })
})

test('renders JSON, like both chat dialects', () => {
  const response = ingress.toResponse(
    { object: 'list', model: 'house-embed', data: [] } as unknown as EmbeddingsResult,
    { 'x-babellm-provider': 'acme' },
  )

  expect(response.headers.get('content-type')).toContain('application/json')
  expect(response.headers.get('x-babellm-provider')).toBe('acme')
})
