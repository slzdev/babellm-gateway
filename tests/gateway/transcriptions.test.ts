import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { handleTranscriptions } from '@/lib/gateway/transcriptions-handler'
import { getHealthStore, resetHealthStore } from '@/lib/health'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { clearRoutingSettingsCache } from '@/lib/routing-settings'
import { MAX_FILE_BYTES } from '@/lib/schemas/transcription'
import { MAX_INLINE_BYTES, assertTranscribable } from '@/lib/translate/transcription-to-gemini'
import type { TranscriptionVerbose } from '@/lib/adapters/types'
import { fakeAdapterByProvider, fakeAdapterDeps, seedGateway, seedPrices, seedTargets } from '../helpers/gateway'
import { waitForLogs } from '../helpers/logs'
import { resetDb } from '../helpers/db'

/**
 * `POST /v1/audio/transcriptions`, end to end through `runGatewayRequest`.
 *
 * The endpoint is a third `Ingress` on the handler that already serves chat
 * and responses, which is a claim about *reuse*: auth, tags, limits, model
 * resolution, breaker-aware ordering, failover, pricing, logging and payload
 * capture are supposed to be the same code, not a second copy. Every one of
 * those was asserted only for the two JSON dialects before this file, so this
 * is where the claim becomes a fact.
 *
 * Two of the tests below carry more weight than the rest. `the second target
 * is handed the same audio bytes as the first` is the whole reason the ingress
 * passes a `File` around instead of a stream: `execute` may call a second
 * adapter, and a one-shot body would make failover silently send nothing. And
 * `payload capture stores the file's metadata and none of its bytes` proves an
 * absence, in every encoding audio could have reached the row in.
 *
 * The client-visible envelope of the two refusals a Gemini target raises
 * (`response_format` and the inline size limit) is
 * tests/gateway/transcription-refusals.test.ts's; what is here about them is
 * the routing and bookkeeping around them — which target was tried, what the
 * attempt chain says, and what the breaker was told.
 */

// A recognizable byte pattern rather than zeroes, so the payload-capture test
// can search a stored row for the audio in every encoding it could have
// arrived in. Nothing else about the bytes matters — the adapter is stubbed.
const MARKER = 'BABELLM-AUDIO-MARKER'

// `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: the bare form
// widens to `ArrayBufferLike`, which `BlobPart` — and so the `File`
// constructor below — does not accept.
function audioBytes(size: number): Uint8Array<ArrayBuffer> {
  const pattern = new TextEncoder().encode(MARKER)
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) bytes[i] = pattern[i % pattern.length]
  return bytes
}

/** Built in memory, never on disk: a fixture file would be one more thing to
 * keep in step with the size limits these tests exercise. */
function audioFile(size = 1024, name = 'clip.mp3', type = 'audio/mpeg') {
  return new File([audioBytes(size)], name, { type })
}

function transcriptionRequest(
  apiKey: string | null,
  fields: Record<string, string | File> = {},
  headers: Record<string, string> = {},
) {
  const form = new FormData()
  form.set('file', audioFile())
  form.set('model', 'house-model')
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  // No content-type header: `FormData` as a body sets it, with the boundary.
  return new Request('http://gateway.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
    body: form,
  })
}

const TOKEN_USAGE = {
  type: 'tokens',
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  total_tokens: 2_000_000,
} as const

const DURATION_USAGE = { type: 'duration', seconds: 12.5 } as const

const verbose: TranscriptionVerbose = {
  duration: 1.5,
  language: 'english',
  text: 'hello there',
  segments: [{
    id: 0,
    seek: 0,
    start: 0,
    end: 1.5,
    text: 'hello there',
    tokens: [1, 2],
    temperature: 0,
    avg_logprob: -0.1,
    compression_ratio: 1.2,
    no_speech_prob: 0.01,
  }],
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

/** The bytes one attempt was handed, base64 so two attempts can be compared
 * exactly rather than approximately. */
async function bytesOf(file: File): Promise<string> {
  return Buffer.from(await file.arrayBuffer()).toString('base64')
}

/**
 * Spies on the circuit breaker's two write paths.
 *
 * Several tests below claim a target was *never charged* for a request it
 * could not serve, and the health store is the only place that would record
 * it. `recordHealth` is fire-and-forget, so `settleHealth` gives those writes
 * a turn of the event loop before the assertion runs.
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

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'b'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
  clearRoutingSettingsCache()
  resetHealthStore()
})

// Every request here writes a log row, and the handler deliberately does not
// await that write. Letting it land before the next test's resetDb truncates
// the key it references is what keeps the run's output clean — an unawaited
// write into a truncated table surfaces as a foreign-key error on stderr.
afterEach(async () => {
  await waitForLogs()
  vi.restoreAllMocks()
  resetHealthStore()
  clearRoutingSettingsCache()
})

// ---------------------------------------------------------------------------
// The five response formats
// ---------------------------------------------------------------------------

test('a json transcription is answered as JSON', async () => {
  const { apiKey } = await seedGateway()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterDeps({ transcribe: async () => ({ text: 'hello there' }) }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/json')
  expect(await res.json()).toEqual({ text: 'hello there' })
})

test('a verbose_json transcription is answered as JSON with its segments intact', async () => {
  const { apiKey } = await seedGateway()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey, { response_format: 'verbose_json' }),
    fakeAdapterDeps({ transcribe: async () => verbose }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/json')
  // Passed through whole: the timestamps are the entire point of the format,
  // and the gateway measures none of them itself.
  expect(await res.json()).toEqual(verbose)
})

// One content type for all three, which is what the upstream API sends and
// what the OpenAI SDK keys its "parse or hand back a string" decision on.
const TEXT_BODIES = {
  text: 'hello there',
  srt: '1\n00:00:00,000 --> 00:00:01,500\nhello there\n',
  vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nhello there\n',
} as const

for (const [format, body] of Object.entries(TEXT_BODIES)) {
  test(`a ${format} transcription is answered as text/plain, byte for byte`, async () => {
    const { apiKey } = await seedGateway()

    const res = await handleTranscriptions(
      transcriptionRequest(apiKey, { response_format: format }),
      fakeAdapterDeps({ transcribe: async () => body }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe(body)
  })
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

test('a token-billed transcription carries its cost beside the usage it was billed on', async () => {
  const { apiKey, provider } = await seedGateway({ upstreamModel: 'gpt-4o-transcribe' })
  await seedPrices(provider.id, 'gpt-4o-transcribe', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterDeps({ transcribe: async () => ({ text: 'hi', usage: TOKEN_USAGE }) }),
  )

  const json = await res.json()
  expect(res.status).toBe(200)
  // The provider's own numbers, untouched — the cost is added beside them,
  // never in place of them.
  expect(json.usage).toMatchObject(TOKEN_USAGE)
  expect(json.usage.cost.currency).toBe('USD')
  expect(Number(json.usage.cost.total)).toBeCloseTo(4, 6)
})

test('a duration-billed transcription reports an unpriced cost rather than zero', async () => {
  // whisper-1 and its clones bill by audio duration, which the catalog has no
  // rate for. `usageOf` therefore measures nothing, so the log records no
  // usage and the cost is null — the gateway's standing rule that a number it
  // did not measure is null and never 0, since a dashboard showing $0.00 for
  // real spend is worse than one showing nothing.
  const { apiKey, provider } = await seedGateway({ upstreamModel: 'whisper-1' })
  await seedPrices(provider.id, 'whisper-1', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterDeps({ transcribe: async () => ({ text: 'hi', usage: DURATION_USAGE }) }),
  )

  const json = await res.json()
  expect(res.status).toBe(200)
  expect(json.usage).toEqual({ ...DURATION_USAGE, cost: null })
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  // Never `seconds` in a token column: a duration there would corrupt every
  // rollup that sums tokens.
  expect(row.promptTokens).toBeNull()
  expect(row.completionTokens).toBeNull()
  expect(row.costUsd).toBeNull()
})

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('a success names the request, the target that served it and the key\'s remaining quota', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 10 } })

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterDeps({ transcribe: async () => ({ text: 'hi' }) }),
  )

  expect(res.headers.get('x-request-id')).toBeTruthy()
  expect(res.headers.get('x-babellm-provider')).toBe('test-provider')
  expect(res.headers.get('x-babellm-upstream-model')).toBe('gpt-4o-mini')
  expect(res.headers.get('x-ratelimit-limit-requests')).toBe('10')
  expect(res.headers.get('x-ratelimit-remaining-requests')).toBe('9')
})

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

test('a retryable failure on the first target is served by the second, and both attempts are logged', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterByProvider({
      primary: { transcribe: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      backup: { transcribe: vi.fn().mockResolvedValue({ text: 'from backup' }) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('backup')
  expect(await res.json()).toEqual({ text: 'from backup' })
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  const detail = await postgresStore.get(row.id)
  expect(detail?.attempts).toHaveLength(2)
  expect(detail?.attempts[0]).toMatchObject({ n: 1, provider: 'primary', status: 503 })
  expect(detail?.attempts[1]).toMatchObject({ n: 2, provider: 'backup', status: 200 })
})

test('the second target is handed the same audio bytes as the first', async () => {
  // The failover-safety proof, and the reason the request carries a `File`
  // rather than a stream. A test that only counted calls would pass against an
  // implementation that consumed the body on the first attempt and sent the
  // second target an empty one, which is a failure no client could diagnose.
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })
  const received: string[] = []

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterByProvider({
      primary: {
        transcribe: async (req) => {
          received.push(await bytesOf(req.file))
          throw apiError(503, 'down')
        },
      },
      backup: {
        transcribe: async (req) => {
          received.push(await bytesOf(req.file))
          return { text: 'from backup' }
        },
      },
    }),
  )

  expect(res.status).toBe(200)
  expect(received).toHaveLength(2)
  expect(received[1]).toBe(received[0])
  // And the bytes are the client's, not merely two copies of the same nothing.
  expect(received[1]).toBe(Buffer.from(audioBytes(1024)).toString('base64'))
})

// ---------------------------------------------------------------------------
// Eligibility: a target that cannot serve *this* request is skipped
// ---------------------------------------------------------------------------

test('an anthropic_messages target is skipped rather than attempted', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'claude', priority: 0, apiFlavor: 'anthropic_messages' },
      { name: 'whisper', priority: 1 },
    ],
  })
  const claude = vi.fn()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterByProvider({
      claude: { transcribe: claude },
      whisper: { transcribe: vi.fn().mockResolvedValue({ text: 'from whisper' }) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('whisper')
  expect(claude).not.toHaveBeenCalled()
  await waitForLogs()

  // One attempt, not two-with-a-failure: the gateway knew from its own
  // configuration that this target has no transcription endpoint, so it cost
  // no attempt, no breaker failure and no round trip to find out.
  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(1)
})

/** Gemini first, Whisper second: the ordering that makes the pair below a
 * coin flip if eligibility were judged at attempt time instead of before it. */
function seedGeminiThenWhisper() {
  return seedTargets({
    targets: [
      { name: 'gem', priority: 0, adapter: 'gemini' },
      { name: 'whisper', priority: 1 },
    ],
  })
}

test('a mixed model answers srt from the target that has timestamps', async () => {
  const { apiKey, targets } = await seedGeminiThenWhisper()
  const gem = vi.fn()
  const health = healthSpies()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey, { response_format: 'srt' }),
    fakeAdapterByProvider({
      gem: { transcribe: gem },
      whisper: { transcribe: vi.fn().mockResolvedValue('1\n00:00:00,000 --> 00:00:01,000\nhi\n') },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('whisper')
  expect(gem).not.toHaveBeenCalled()
  await waitForLogs()
  await settleHealth()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(1)
  // Steered past, not tried and failed: the Gemini target learns nothing about
  // itself from a request it was never eligible for. The Whisper target's own
  // success is asserted alongside it, so "no record" is a fact about the
  // filtered candidate rather than about a spy that saw nothing.
  expect(targetsTouched(health)).toEqual([targets[1].target.id])
})

test('the same mixed model answers json from the Gemini target, which can serve it', async () => {
  // The other half of the pair. `supports` filters the Gemini candidate out
  // for `srt` only, so its eligibility is a property of the request rather
  // than of the target — and this is the direction that would break if the
  // filter were widened into "Gemini cannot transcribe".
  const { apiKey } = await seedGeminiThenWhisper()
  const whisper = vi.fn()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterByProvider({
      gem: { transcribe: vi.fn().mockResolvedValue({ text: 'from gemini' }) },
      whisper: { transcribe: whisper },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('gem')
  expect(await res.json()).toEqual({ text: 'from gemini' })
  expect(whisper).not.toHaveBeenCalled()
})

test('a mixed model answers oversized audio from the target that takes an upload', async () => {
  // Size steers the chain exactly as the format does, and for the same reason:
  // it is knowable from the request alone. Gemini takes its audio inline, so a
  // file over that ceiling does not fit in one of its requests at all — and
  // without this filter, which target answered would depend on the policy's
  // draw rather than on what was asked for.
  const { apiKey, targets } = await seedGeminiThenWhisper()
  const gem = vi.fn()
  const health = healthSpies()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey, { file: audioFile(MAX_INLINE_BYTES + 1) }),
    fakeAdapterByProvider({
      gem: { transcribe: gem },
      whisper: { transcribe: vi.fn().mockResolvedValue({ text: 'from whisper' }) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('whisper')
  expect(gem).not.toHaveBeenCalled()
  await waitForLogs()
  await settleHealth()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.attempts).toHaveLength(1)
  expect(targetsTouched(health)).toEqual([targets[1].target.id])
})

test('a Gemini-only model asked for srt records one 400 attempt and no breaker failure', async () => {
  // When `supports` rejects every candidate the handler falls back to the
  // unfiltered chain, so the answer comes from the adapter that knows why.
  // The client-visible envelope of that 400 — status, code, message and
  // `param` — is tests/gateway/transcription-refusals.test.ts's; what this
  // test pins is the bookkeeping around it: the refusal is raised before any
  // upstream call, so it costs one recorded attempt and tells the breaker
  // nothing.
  const { apiKey } = await seedGateway({ adapter: 'gemini' })
  const upstream = vi.fn()
  const health = healthSpies()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey, { response_format: 'srt' }),
    fakeAdapterDeps({
      transcribe: async (req) => {
        assertTranscribable(req, 'test-provider')
        return upstream()
      },
    }),
  )

  expect(res.status).toBe(400)
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
  expect(detail?.errorType).toBe('invalid_request_error')
  // Nothing at all: a refusal raised before the call is not evidence about
  // the target, so the breaker is told neither success nor failure.
  expect(targetsTouched(health)).toEqual([])
})

test('a model whose only target is anthropic_messages answers 501 naming the provider', async () => {
  // Driven through the real registry, because the message is
  // withTranscribeUnsupported's and the point is that the client is told which
  // provider cannot do this and why — not a generic "not implemented".
  const { apiKey } = await seedTargets({
    targets: [{ name: 'claude', apiFlavor: 'anthropic_messages' }],
  })

  const res = await handleTranscriptions(transcriptionRequest(apiKey))

  expect(res.status).toBe(501)
  const payload = await res.json()
  expect(payload.error.code).toBe('unsupported_operation')
  expect(payload.error.message).toContain('claude')
  expect(payload.error.message).toContain('Anthropic Messages API')
})

// ---------------------------------------------------------------------------
// The rest of the shared lifecycle
// ---------------------------------------------------------------------------

test('a key over its rpm limit is refused before any provider is called', async () => {
  const { apiKey } = await seedGateway({ limits: { rpmLimit: 1 } })

  const first = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterDeps({ transcribe: async () => ({ text: 'hi' }) }),
  )
  expect(first.status).toBe(200)

  const blocked = vi.fn()
  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterDeps({ transcribe: blocked }),
  )

  expect(res.status).toBe(429)
  expect((await res.json()).error.code).toBe('rate_limit_exceeded')
  expect(blocked).not.toHaveBeenCalled()
})

test('x-babellm-tags reaches the log row', async () => {
  const { apiKey } = await seedGateway()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey, {}, { 'x-babellm-tags': 'env=prod,feature=voicemail' }),
    fakeAdapterDeps({ transcribe: async () => ({ text: 'hi' }) }),
  )
  expect(res.status).toBe(200)
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.tags).toEqual({ env: 'prod', feature: 'voicemail' })
})

test('the log row agrees with the response the client was given', async () => {
  const { apiKey, provider, target } = await seedGateway({ upstreamModel: 'gpt-4o-transcribe' })
  await seedPrices(provider.id, 'gpt-4o-transcribe', {
    inputPerMtok: '1.000000', outputPerMtok: '3.000000',
  })

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterDeps({ transcribe: async () => ({ text: 'hi', usage: TOKEN_USAGE }) }),
  )
  const clientTotal = (await res.json()).usage.cost.total
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row).toMatchObject({
    model: 'house-model',
    keyName: 'test key',
    status: 200,
    outcome: 'ok',
    // Never true for this dialect: the schema refuses `stream` outright.
    stream: false,
    finalProvider: 'test-provider',
    finalUpstreamModel: 'gpt-4o-transcribe',
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  })
  expect(row.latencyMs).toBeGreaterThanOrEqual(0)
  expect(Number(row.costUsd)).toBe(Number(clientTotal))
  expect((await postgresStore.get(row.id))?.finalTargetId).toBe(target.id)
})

test('payload capture stores the file\'s metadata and none of its bytes', async () => {
  // Absence is the claim, so this asserts absence — in every encoding audio
  // could have reached the row in, and from every part it could have come
  // from. The request deliberately carries a *second* file part under a key
  // the schema knows nothing about: unknown fields pass through into the
  // captured request, so a stray upload is one of the ways bytes could arrive
  // that substituting `file` alone would not stop.
  const seeded = await seedGateway()
  await db.update(apiKeys).set({ logPayloads: true }).where(eq(apiKeys.id, seeded.key.id))

  // Larger than the default 256 KB payload cap, so bytes stored in any
  // encoding would have to show up as a truncation envelope even if the
  // marker search somehow missed them.
  const size = 300_000
  const form = new FormData()
  form.set('file', audioFile(size, 'voicemail.mp3', 'audio/mpeg'))
  form.set('model', 'house-model')
  form.set('language', 'en')
  form.set('stray_upload', audioFile(size, 'stray.mp3', 'audio/mpeg'))
  const request = new Request('http://gateway.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${seeded.apiKey}` },
    body: form,
  })

  const res = await handleTranscriptions(
    request,
    fakeAdapterDeps({ transcribe: async () => ({ text: 'hi' }) }),
  )
  expect(res.status).toBe(200)
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect(row.payloadCaptured).toBe(true)

  const detail = await postgresStore.get(row.id)
  const stored = detail?.payload?.request as Record<string, unknown>
  // What capture is *for*: the fields the client sent, and enough about the
  // file to diagnose a problem with it.
  expect(stored.model).toBe('house-model')
  expect(stored.language).toBe('en')
  expect(stored.file).toEqual({ name: 'voicemail.mp3', size, type: 'audio/mpeg' })

  const serialized = JSON.stringify(detail)
  const raw = Buffer.from(audioBytes(size))
  // Directly (the bytes are ASCII, so a raw copy reads as the marker), as
  // base64, and as hex. A partial copy still matches: the marker repeats
  // every 20 bytes, and both encodings are sampled from the start.
  expect(serialized).not.toContain(MARKER)
  expect(serialized).not.toContain(raw.toString('base64').slice(0, 64))
  expect(serialized).not.toContain(raw.toString('hex').slice(0, 64))
  // And nothing bulky reached the row under any name: 600 KB of audio stored
  // in any encoding would have tripped the cap.
  expect(detail?.payload?.truncated).toBe(false)
  expect(serialized.length).toBeLessThan(4096)
})

test('stream=true is refused with 400 and never reaches a provider', async () => {
  const { apiKey } = await seedGateway()
  const transcribe = vi.fn()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey, { stream: 'true' }),
    fakeAdapterDeps({ transcribe }),
  )

  expect(res.status).toBe(400)
  expect((await res.json()).error).toMatchObject({
    code: 'unsupported_parameter', param: 'stream',
  })
  expect(transcribe).not.toHaveBeenCalled()
})

test('a file over the 25 MB cap is refused with 400 and never reaches a provider', async () => {
  const { apiKey } = await seedGateway()
  const transcribe = vi.fn()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey, { file: audioFile(MAX_FILE_BYTES + 1) }),
    fakeAdapterDeps({ transcribe }),
  )

  expect(res.status).toBe(400)
  const payload = await res.json()
  expect(payload.error.param).toBe('file')
  expect(payload.error.message).toContain('25 MB')
  expect(transcribe).not.toHaveBeenCalled()
})

test('an unknown model is refused with 404 in the standard error envelope', async () => {
  const { apiKey } = await seedGateway()

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey, { model: 'nope' }),
    fakeAdapterDeps({ transcribe: vi.fn() }),
  )

  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toBe('application/json')
  expect((await res.json()).error).toMatchObject({
    type: 'invalid_request_error', code: 'model_not_found',
  })
})

test('a pinned service tier is reported as dropped rather than sent to the provider', async () => {
  // The regression this pins is a real one: `service_tier` used to be spread
  // into the request every ingress hands its adapter, and the OpenAI-shaped
  // transcription adapter spreads that straight into the upstream multipart
  // form — so a tiered target answered a 400 for an unknown part.
  const { apiKey } = await seedTargets({
    targets: [{ name: 'tiered', serviceTier: 'flex' }],
  })
  const transcribe = vi.fn().mockResolvedValue({ text: 'hi' })

  const res = await handleTranscriptions(
    transcriptionRequest(apiKey),
    fakeAdapterByProvider({ tiered: { transcribe } }),
  )

  expect(res.status).toBe(200)
  const sent = transcribe.mock.calls[0][0] as Record<string, unknown>
  expect(sent).not.toHaveProperty('service_tier')
  expect(res.headers.get('x-babellm-dropped-params')?.split(',')).toContain('service_tier')
  await waitForLogs()

  const [row] = (await postgresStore.query({ limit: 1 })).rows
  expect((await postgresStore.get(row.id))?.droppedParams).toContain('service_tier')
})
