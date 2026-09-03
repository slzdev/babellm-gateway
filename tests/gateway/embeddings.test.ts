import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { eq } from 'drizzle-orm'
import type { EmbeddingsResult } from '@/lib/adapters/types'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { generateApiKey } from '@/lib/gateway/auth'
import { handleEmbeddings } from '@/lib/gateway/embeddings-handler'
import { getHealthStore, resetHealthStore } from '@/lib/health'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { setLoggingSettings } from '@/lib/settings'
import { toEmbedParams } from '@/lib/translate/embeddings-to-gemini'
import {
  embeddingsRequest, fakeAdapterByProvider, fakeAdapterDeps, seedGateway, seedPrices, seedTargets,
  type SeedOptions,
} from '../helpers/gateway'
import { resetDb } from '../helpers/db'
import { waitForLogs } from '../helpers/logs'

const body = { model: 'house-embed', input: ['hello', 'world'] }

const upstreamEmbeddings = {
  object: 'list',
  model: 'text-embedding-3-small',
  data: [
    { object: 'embedding', index: 0, embedding: [0.01, -0.02] },
    { object: 'embedding', index: 1, embedding: [0.03, -0.04] },
  ],
  usage: { prompt_tokens: 4, total_tokens: 4 },
}

/** seedGateway's defaults describe a chat model; every case here wants the
 *  same embedding one. */
function seedEmbeddings(options: SeedOptions = {}) {
  return seedGateway({
    virtualModel: 'house-embed',
    upstreamModel: 'text-embedding-3-small',
    ...options,
  })
}

function embeddingTargets(names: string[]) {
  return seedTargets({
    virtualModel: 'house-embed',
    targets: names.map((name, priority) => ({ name, priority })),
  })
}

const deps = () => fakeAdapterDeps({ embed: vi.fn().mockResolvedValue(upstreamEmbeddings) })

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

/**
 * Spies on the circuit breaker's two write paths.
 *
 * The steering tests below claim a target was *never charged* for a request it
 * was not eligible for, and the health store is the only place that would
 * record it. `recordHealth` is fire-and-forget, so `settleHealth` gives those
 * writes a turn of the event loop before the assertion runs.
 */
function healthSpies() {
  const store = getHealthStore()
  return { succeed: vi.spyOn(store, 'succeed'), fail: vi.spyOn(store, 'fail') }
}

function targetsTouched(spies: ReturnType<typeof healthSpies>): string[] {
  return [...spies.succeed.mock.calls, ...spies.fail.mock.calls].map((call) => call[0])
}

async function settleHealth() {
  await new Promise((resolve) => setImmediate(resolve))
}

/** A Gemini target first, an OpenAI-shaped one behind it — the mixed chain the
 *  routing filter exists for. */
function seedGeminiThenOpenAI() {
  return seedTargets({
    virtualModel: 'house-embed',
    targets: [
      { name: 'gem', priority: 0, adapter: 'gemini' },
      { name: 'oai', priority: 1 },
    ],
  })
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
  resetHealthStore()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  await waitForLogs()
  vi.restoreAllMocks()
  resetHealthStore()
})

test('returns one vector per input, in the order they were sent', async () => {
  const { apiKey } = await seedEmbeddings()

  const res = await handleEmbeddings(embeddingsRequest(body, apiKey), deps())
  const json = await res.json()

  expect(res.status).toBe(200)
  expect(json.object).toBe('list')
  expect(json.data).toEqual([
    { object: 'embedding', index: 0, embedding: [0.01, -0.02] },
    { object: 'embedding', index: 1, embedding: [0.03, -0.04] },
  ])
})

test('rewrites the model to the virtual name and names the target that served', async () => {
  const { apiKey } = await seedEmbeddings()
  const embed = vi.fn().mockResolvedValue(upstreamEmbeddings)

  const res = await handleEmbeddings(embeddingsRequest(body, apiKey), fakeAdapterDeps({ embed }))

  expect((await res.json()).model).toBe('house-embed')
  expect(res.headers.get('x-babellm-provider')).toBe('test-provider')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('text-embedding-3-small')
  expect(res.headers.get('x-request-id')).toBeTruthy()
  expect(embed.mock.calls[0][1].upstreamModel).toBe('text-embedding-3-small')
})

test('prices the request on its input tokens alone', async () => {
  const { apiKey, provider } = await seedEmbeddings()
  // An embedding model's catalog row as it really looks: an input rate and no
  // output rate, because there is no output to charge for. computeCost would
  // call this half-priced and report it unpriced; the ingress bills it with
  // computeInputOnlyCost instead (spec 3.5).
  await seedPrices(provider.id, 'text-embedding-3-small', { inputPerMtok: '0.020000' })

  const res = await handleEmbeddings(embeddingsRequest(body, apiKey), deps())

  expect((await res.json()).usage).toEqual({
    prompt_tokens: 4,
    total_tokens: 4,
    cost: {
      currency: 'USD',
      input: '0.000000080',
      cached: '0.000000000',
      output: '0.000000000',
      total: '0.000000080',
    },
  })
})

test('rejects a request with no API key', async () => {
  await seedEmbeddings()

  const res = await handleEmbeddings(embeddingsRequest(body, null), deps())

  expect(res.status).toBe(401)
  expect((await res.json()).error.code).toBe('missing_api_key')
})

test('rejects a key it never issued', async () => {
  await seedEmbeddings()

  const res = await handleEmbeddings(embeddingsRequest(body, 'sk-bab-nope'), deps())

  expect(res.status).toBe(401)
  expect((await res.json()).error.code).toBe('invalid_api_key')
})

test('rejects an unknown virtual model with 404', async () => {
  const { apiKey } = await seedEmbeddings()

  const res = await handleEmbeddings(
    embeddingsRequest({ ...body, model: 'nope' }, apiKey),
    deps(),
  )

  expect(res.status).toBe(404)
  expect((await res.json()).error.code).toBe('model_not_found')
})

test('a model whose every target is disabled is a 503, not a 404', async () => {
  const { apiKey } = await seedTargets({
    virtualModel: 'house-embed',
    targets: [{ name: 'off', enabled: false }],
  })

  const res = await handleEmbeddings(embeddingsRequest(body, apiKey), deps())

  expect(res.status).toBe(503)
  expect((await res.json()).error.code).toBe('no_targets_available')
})

test('a key over its rpm limit is rejected with 429 and the rate limit headers', async () => {
  const { apiKey } = await seedEmbeddings({ limits: { rpmLimit: 1 } })
  await handleEmbeddings(embeddingsRequest(body, apiKey), deps())

  const res = await handleEmbeddings(embeddingsRequest(body, apiKey), deps())

  expect(res.status).toBe(429)
  expect((await res.json()).error).toMatchObject({
    type: 'rate_limit_error', code: 'rate_limit_exceeded',
  })
  expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  expect(res.headers.get('x-ratelimit-limit-requests')).toBe('1')
  expect(res.headers.get('x-ratelimit-remaining-requests')).toBe('0')
  expect(res.headers.get('x-request-id')).toBeTruthy()
})

test('a rate limit rejection is not written to the request log', async () => {
  // The omission is deliberate (handler.ts's catch returns before logging):
  // a limit rejection never reached a provider, and one row per rejected
  // request is the traffic pattern that grows fastest exactly when the
  // gateway is under the most stress.
  const { apiKey } = await seedEmbeddings({ limits: { rpmLimit: 1 } })
  await handleEmbeddings(embeddingsRequest(body, apiKey), deps())
  await waitForLogs(1)

  const rejected = await handleEmbeddings(embeddingsRequest(body, apiKey), deps())
  expect(rejected.status).toBe(429)

  // A second served request, on a key of its own, is a real ordering barrier:
  // its log write can only be queued after the rejected request's handler
  // call returned, so a write the rejection had queued would already have
  // landed by the time this one does. A fixed sleep would only be a guess.
  const other = generateApiKey()
  await db.insert(apiKeys).values({
    name: 'other key', keyHash: other.keyHash, keyPrefix: other.keyPrefix,
  })
  await handleEmbeddings(embeddingsRequest(body, other.key), deps())
  await waitForLogs(2)

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows).toHaveLength(2)
  expect(page.rows.every((row) => row.status !== 429)).toBe(true)
})

test('failover walks to the next target, and the log row keeps both attempts', async () => {
  const { apiKey } = await embeddingTargets(['primary', 'backup'])

  const res = await handleEmbeddings(
    embeddingsRequest(body, apiKey),
    fakeAdapterByProvider({
      primary: { embed: vi.fn().mockRejectedValue(apiError(429, 'slow down')) },
      backup: { embed: vi.fn().mockResolvedValue(upstreamEmbeddings) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('backup')
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({
    status: 200, outcome: 'ok', finalProvider: 'backup', finalUpstreamModel: 'backup-model',
  })

  const detail = await postgresStore.get(row.id)
  expect(detail?.attempts).toHaveLength(2)
  expect(detail?.attempts[0]).toMatchObject({ n: 1, provider: 'primary', status: 429 })
  expect(detail?.attempts[1]).toMatchObject({ n: 2, provider: 'backup', status: 200 })
})

test('an anthropic_messages target is steered past, and the sibling serves', async () => {
  // The behaviour this endpoint settled on: `supports` filters a candidate
  // that cannot embed out of the chain *before* ordering, so a viable sibling
  // answers the request instead of the client getting a 501 from a model that
  // has a working target. Filtering before `selectOrder` is what makes it
  // deterministic — after it, the operator's maxAttempts could have truncated
  // the chain to nothing but ineligible candidates.
  const { apiKey, targets } = await seedTargets({
    virtualModel: 'house-embed',
    targets: [
      { name: 'clone', priority: 0, apiFlavor: 'anthropic_messages' },
      { name: 'healthy', priority: 1 },
    ],
  })
  const clone = vi.fn()
  const health = healthSpies()

  const res = await handleEmbeddings(
    embeddingsRequest(body, apiKey),
    fakeAdapterByProvider({
      clone: { embed: clone },
      healthy: { embed: vi.fn().mockResolvedValue(upstreamEmbeddings) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('healthy')
  expect(clone).not.toHaveBeenCalled()
  await waitForLogs()
  await settleHealth()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(1)
  // Steered past, not tried and failed: the ineligible target learns nothing
  // about itself from a request it was never eligible for. The serving
  // target's own success is asserted alongside it, so "no record" is a fact
  // about the filtered candidate rather than about a spy that saw nothing.
  expect(targetsTouched(health)).toEqual([targets[1].target.id])
})

test('a model whose only target is anthropic_messages answers 501 naming the provider', async () => {
  // Driven through the real registry, because the message is
  // withEmbedUnsupported's and the point is that the client is told which
  // provider cannot do this and why — not a generic "not implemented".
  //
  // `supports` rejects the one candidate there is, and the handler then orders
  // the unfiltered chain rather than refusing on its own: a generic "no target
  // of this model can embed" would carry neither the provider nor the remedy.
  const { apiKey } = await seedTargets({
    virtualModel: 'house-embed',
    targets: [{ name: 'claude', apiFlavor: 'anthropic_messages' }],
  })

  const res = await handleEmbeddings(embeddingsRequest(body, apiKey))

  expect(res.status).toBe(501)
  const json = await res.json()
  expect(json.error.code).toBe('unsupported_operation')
  expect(json.error.message).toContain('claude')
  expect(json.error.message).toContain('Anthropic Messages API')

  await waitForLogs()
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ status: 501, outcome: 'error' })
  // Asserted rather than inferred from the envelope: one recorded attempt is
  // what distinguishes the all-ineligible fallback — which ordered the
  // unfiltered chain so the adapter could name the provider — from an empty
  // chain, whose only possible answer would have been a generic 503.
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(1)
})

test('a mixed model answers token-array input from the target that takes tokens', async () => {
  // The improvement the filter buys on this endpoint. Token ids are knowable
  // from the request alone, and Gemini embeds text — so the request steers to
  // the OpenAI-shaped sibling instead of depending on which target selection
  // happened to pick.
  const { apiKey, targets } = await seedGeminiThenOpenAI()
  const gem = vi.fn()
  const health = healthSpies()

  const res = await handleEmbeddings(
    embeddingsRequest({ model: 'house-embed', input: [15339, 1917] }, apiKey),
    fakeAdapterByProvider({
      gem: { embed: gem },
      oai: { embed: vi.fn().mockResolvedValue(upstreamEmbeddings) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('oai')
  expect(gem).not.toHaveBeenCalled()
  await waitForLogs()
  await settleHealth()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(1)
  expect(targetsTouched(health)).toEqual([targets[1].target.id])
})

test('the same mixed model answers text input from the Gemini target, which can serve it', async () => {
  // The other half of the pair. `supports` filters the Gemini candidate out
  // for token ids only, so its eligibility is a property of the request rather
  // than of the target — and this is the direction that would break if the
  // filter were widened into "Gemini cannot embed".
  const { apiKey } = await seedGeminiThenOpenAI()
  const oai = vi.fn()

  const res = await handleEmbeddings(
    embeddingsRequest(body, apiKey),
    fakeAdapterByProvider({
      gem: { embed: vi.fn().mockResolvedValue(upstreamEmbeddings) },
      oai: { embed: oai },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('gem')
  expect(oai).not.toHaveBeenCalled()
})

test('a Gemini-only model handed token ids answers 400 naming input, and no breaker failure', async () => {
  // The all-ineligible fallback for the other rule: nothing survives the
  // filter, so the request reaches the adapter and the real translator refuses
  // it. That refusal names the field and the remedy, which a handler-level
  // 501 could not. It is raised before any upstream call, so it costs one
  // recorded attempt and tells the breaker nothing.
  const { apiKey } = await seedEmbeddings({ adapter: 'gemini' })
  const upstream = vi.fn()
  const health = healthSpies()

  const res = await handleEmbeddings(
    embeddingsRequest({ model: 'house-embed', input: [15339, 1917] }, apiKey),
    fakeAdapterDeps({
      embed: async (req, ctx) => {
        toEmbedParams(req, ctx, 'test-provider')
        return upstream()
      },
    }),
  )

  expect(res.status).toBe(400)
  const json = await res.json()
  expect(json.error).toMatchObject({
    type: 'invalid_request_error',
    code: 'unsupported_input',
  })
  expect(json.error.message).toContain('test-provider')
  expect(upstream).not.toHaveBeenCalled()
  await waitForLogs()
  await settleHealth()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({ status: 400, outcome: 'error' })
  const detail = await postgresStore.get(row.id)
  // One attempt at 400, not an empty chain and not a 501: the request did
  // reach a target, which is what let it be told which field to change.
  expect(detail?.attempts).toHaveLength(1)
  expect(detail?.attempts[0]).toMatchObject({ n: 1, provider: 'test-provider', status: 400 })
  // Nothing at all: a refusal raised before the call is not evidence about the
  // target, so the breaker is told neither success nor failure.
  expect(targetsTouched(health)).toEqual([])
})

test('the log row records an unstreamed request, its prompt tokens and a zero output', async () => {
  const { apiKey, provider } = await seedEmbeddings()
  await seedPrices(provider.id, 'text-embedding-3-small', { inputPerMtok: '0.020000' })

  const res = await handleEmbeddings(embeddingsRequest(body, apiKey), deps())
  const clientTotal = (await res.json()).usage.cost.total
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({
    model: 'house-embed',
    keyName: 'test key',
    status: 200,
    outcome: 'ok',
    // No streaming block on this ingress, so there is nothing for the column
    // to record but false.
    stream: false,
    finalProvider: 'test-provider',
    finalUpstreamModel: 'text-embedding-3-small',
    promptTokens: 4,
    // A measured zero rather than a null: an embeddings response has no
    // output tokens to leave unmeasured.
    completionTokens: 0,
  })
  expect(row.costUsd).toBe(clientTotal)

  const detail = await postgresStore.get(row.id)
  expect(detail).toMatchObject({
    inputCostUsd: '0.000000080',
    cachedCostUsd: '0.000000000',
    outputCostUsd: '0.000000000',
  })
  // The rates the client never sees are still on the row, output rate
  // included — the snapshot a charge was drawn from, not just the rates that
  // happened to be multiplied.
  expect(detail?.pricing).toMatchObject({ inputPerMtok: '0.020000', outputPerMtok: null })
})

test('x-babellm-tags lands on the log row', async () => {
  const { apiKey } = await seedEmbeddings()

  const res = await handleEmbeddings(
    embeddingsRequest(body, apiKey, { 'x-babellm-tags': 'env=prod,pipeline=ingest' }),
    deps(),
  )
  expect(res.status).toBe(200)
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.tags).toEqual({ env: 'prod', pipeline: 'ingest' })
})

test('a gemini target reports and logs the parameter it cannot express', async () => {
  const { apiKey } = await seedTargets({
    virtualModel: 'house-embed',
    targets: [{ name: 'gem', adapter: 'gemini' }],
  })

  const res = await handleEmbeddings(
    embeddingsRequest({ ...body, user: 'u-42' }, apiKey),
    fakeAdapterByProvider({ gem: { embed: vi.fn().mockResolvedValue(upstreamEmbeddings) } }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-dropped-params')).toBe('user')
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.droppedParams).toEqual(['user'])
})

test('a key with payload logging on stores the request and the vectors it returned', async () => {
  const { apiKey, key } = await seedEmbeddings()
  await db.update(apiKeys).set({ logPayloads: true }).where(eq(apiKeys.id, key.id))

  await handleEmbeddings(embeddingsRequest(body, apiKey), deps())
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.payloadCaptured).toBe(true)

  const detail = await postgresStore.get(row.id)
  expect(detail?.payload?.truncated).toBe(false)
  expect(detail?.payload?.request).toMatchObject({ model: 'house-embed', input: ['hello', 'world'] })
  // The response as the client received it — the virtual model name, not the
  // upstream one.
  const response = detail?.payload?.response as { model: string; data: unknown[] }
  expect(response.model).toBe('house-embed')
  expect(response.data).toHaveLength(2)
})

test('vectors past the payload cap are stored as the truncation envelope', async () => {
  const { apiKey, key } = await seedEmbeddings()
  await db.update(apiKeys).set({ logPayloads: true }).where(eq(apiKeys.id, key.id))
  // A cap between the two bodies rather than vectors big enough to breach a
  // realistic one: what is being pinned is which side overflows, and a
  // 3072-dimension response would be megabytes of generated floats to say
  // the same thing.
  await setLoggingSettings({ payloadMaxBytes: 120 })
  clearRequestLogStoreCache()

  await handleEmbeddings(embeddingsRequest(body, apiKey), deps())
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.id)
  expect(detail?.payload?.truncated).toBe(true)
  expect(detail?.payload?.response).toMatchObject({ truncated: true })
  // The request fits, so it is stored whole: `truncated` on the payload is
  // the response's doing, and the reader can tell which half was cut.
  expect(detail?.payload?.request).toMatchObject({ model: 'house-embed' })
})

test('a base64 request gets its strings back untouched', async () => {
  const { apiKey } = await seedEmbeddings()
  // The SDK types `embedding` as number[] even though a base64 response is a
  // string, so the fixture says what the wire says and casts.
  const encoded = {
    object: 'list',
    model: 'text-embedding-3-small',
    data: [{ object: 'embedding', index: 0, embedding: 'CtejPAAAAAA=' }],
    usage: { prompt_tokens: 2, total_tokens: 2 },
  } as unknown as EmbeddingsResult
  const embed = vi.fn().mockResolvedValue(encoded)

  const res = await handleEmbeddings(
    embeddingsRequest(
      { model: 'house-embed', input: 'hello', encoding_format: 'base64' },
      apiKey,
    ),
    fakeAdapterDeps({ embed }),
  )
  const json = await res.json()

  expect(embed.mock.calls[0][0].encoding_format).toBe('base64')
  // Passed through, not decoded into floats and not re-encoded: the gateway
  // relays the encoding the client asked for.
  expect(json.data[0].embedding).toBe('CtejPAAAAAA=')
})
