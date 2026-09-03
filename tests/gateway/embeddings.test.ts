import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { eq } from 'drizzle-orm'
import type { EmbeddingsResult, ProviderAdapter } from '@/lib/adapters/types'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { generateApiKey } from '@/lib/gateway/auth'
import { handleEmbeddings } from '@/lib/gateway/embeddings-handler'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { setLoggingSettings } from '@/lib/settings'
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
 * Deps whose adapters have no `embed` property at all, except where a test
 * names one.
 *
 * fakeAdapterByProvider cannot express this: its default set supplies a
 * throwing `embed`, and a throw from inside `embed` is a provider error, not
 * the absence the ingress turns into a 501.
 */
function depsWithoutEmbed(byName: Record<string, Partial<ProviderAdapter>> = {}) {
  return {
    createAdapter: (provider: { name: string }) => ({
      async chat() {
        throw new Error(`chat not stubbed for ${provider.name}`)
      },
      ...(byName[provider.name] ?? {}),
    }) as ProviderAdapter,
  }
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
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

test('a target whose adapter cannot embed answers 501 unsupported_operation', async () => {
  const { apiKey } = await seedTargets({
    virtualModel: 'house-embed',
    targets: [{ name: 'clone', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' }],
  })

  const res = await handleEmbeddings(embeddingsRequest(body, apiKey), depsWithoutEmbed())
  const json = await res.json()

  expect(res.status).toBe(501)
  expect(json.error.code).toBe('unsupported_operation')
  // The provider and its flavor, because that pair is where the fix is made.
  expect(json.error.message).toContain('clone')
  expect(json.error.message).toContain('Anthropic Messages')
})

test('a target that cannot embed is not failed over to a healthy sibling', async () => {
  // Spec 3.7, and the whole reason the refusal is non-retryable: a target
  // that cannot serve the operation at all is a misconfiguration, and a
  // sibling quietly covering for it hides the fault until the day that
  // sibling is down.
  const { apiKey } = await seedTargets({
    virtualModel: 'house-embed',
    targets: [
      { name: 'clone', priority: 0, adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' },
      { name: 'healthy', priority: 1 },
    ],
  })
  const healthy = vi.fn().mockResolvedValue(upstreamEmbeddings)

  const res = await handleEmbeddings(
    embeddingsRequest(body, apiKey),
    depsWithoutEmbed({ healthy: { embed: healthy } }),
  )

  expect(res.status).toBe(501)
  expect(healthy).not.toHaveBeenCalled()
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(1)
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
