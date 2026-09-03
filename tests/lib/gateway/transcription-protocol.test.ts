import { expect, test, vi } from 'vitest'
import type { AttemptContext, ProviderAdapter, TranscriptionResult } from '@/lib/adapters/types'
import { GatewayError } from '@/lib/gateway/errors'
import { transcriptionIngress as ingress } from '@/lib/gateway/protocols/transcription'
import type { Candidate } from '@/lib/gateway/resolve'
import type { TranscriptionFormat, TranscriptionRequest } from '@/lib/schemas/transcription'
import { MAX_INLINE_BYTES } from '@/lib/translate/transcription-to-gemini'

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

function audioFile(bytes = 1024, name = 'clip.mp3', type = 'audio/mpeg') {
  return new File([new Uint8Array(bytes)], name, { type })
}

function request(fields: Record<string, string | File> = {}): Request {
  const form = new FormData()
  form.set('file', audioFile())
  form.set('model', 'whisper-1')
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return new Request('http://gateway.test/v1/audio/transcriptions', { method: 'POST', body: form })
}

function req(overrides: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
  return { file: audioFile(), model: 'whisper-1', response_format: 'json', ...overrides }
}

const identity = { id: '', model: 'virtual-whisper' }
const cost = { currency: 'USD' as const, input: '0.000001000', cached: null, output: '0.000002000', total: '0.000003000' }

// --- read ------------------------------------------------------------------

test('reads and validates a multipart body', async () => {
  const parsed = await ingress.read(request({ response_format: 'srt', temperature: '0.2' }))

  expect(parsed.model).toBe('whisper-1')
  expect(parsed.response_format).toBe('srt')
  expect(parsed.temperature).toBe(0.2)
  expect(parsed.file).toBeInstanceOf(File)
})

test('refuses a body that is not multipart at all', async () => {
  const json = new Request('http://gateway.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'whisper-1' }),
  })

  const err = await ingress.read(json).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(GatewayError)
  expect((err as GatewayError).status).toBe(400)
  expect((err as GatewayError).code).toBe('invalid_form')
})

test('lets the schema own its own refusals rather than relabelling them', async () => {
  // `stream: true` is a GatewayError thrown from inside the schema. It must
  // reach the client as `unsupported_parameter`, not be swallowed by read's
  // "this was not a form" catch.
  const err = await ingress.read(request({ stream: 'true' })).catch((e: unknown) => e)

  expect(err).toBeInstanceOf(GatewayError)
  expect((err as GatewayError).code).toBe('unsupported_parameter')
})

// --- the one-liners --------------------------------------------------------

test('names the model and never streams', () => {
  expect(ingress.modelOf(req({ model: 'whisper-large-v3' }))).toBe('whisper-large-v3')
  expect(ingress.isStream(req())).toBe(false)
})

test('runs the adapter transcription', async () => {
  const transcribe = vi.fn().mockResolvedValue({ text: 'hello' })
  const body = req()
  const ctx = {} as AttemptContext

  const result = await ingress.run({ transcribe } as unknown as ProviderAdapter, ctx, body)

  expect(transcribe).toHaveBeenCalledWith(body, ctx)
  expect(result).toEqual({ text: 'hello' })
})

// --- supports --------------------------------------------------------------

test('an anthropic_messages candidate never transcribes, whatever was asked for', () => {
  const anthropic = candidate('openai_compatible', 'anthropic_messages')
  for (const format of ['json', 'verbose_json', 'text', 'srt', 'vtt'] as TranscriptionFormat[]) {
    expect(ingress.supports?.(anthropic, req({ response_format: format }))).toBe(false)
  }
})

test('a Gemini candidate serves json and text but not the timestamp formats', () => {
  const gemini = candidate('gemini', 'chat_completions')

  expect(ingress.supports?.(gemini, req({ response_format: 'json' }))).toBe(true)
  expect(ingress.supports?.(gemini, req({ response_format: 'text' }))).toBe(true)
  expect(ingress.supports?.(gemini, req({ response_format: 'verbose_json' }))).toBe(false)
  expect(ingress.supports?.(gemini, req({ response_format: 'srt' }))).toBe(false)
  expect(ingress.supports?.(gemini, req({ response_format: 'vtt' }))).toBe(false)
})

test('a Gemini candidate is ineligible for audio over its inline ceiling', () => {
  // The same rule as the formats above, applied to the other thing
  // assertTranscribable refuses: both are knowable from the request alone, so
  // both must be known before ordering. Otherwise a 22 MB file against a mixed
  // Gemini+Whisper model is served by the Whisper target only when selection
  // happens to pick it — and refused with a 400 when it does not.
  const gemini = candidate('gemini', 'chat_completions')

  expect(ingress.supports?.(gemini, req({ file: audioFile(MAX_INLINE_BYTES + 1) }))).toBe(false)
  expect(ingress.supports?.(gemini, req({ file: audioFile(MAX_INLINE_BYTES) }))).toBe(true)
  // An OpenAI-shaped target has no inline ceiling — 20 MB is Gemini's request
  // limit, not the endpoint's, and the schema's own 25 MB cap has already had
  // its say.
  expect(ingress.supports?.(
    candidate('openai', 'chat_completions'),
    req({ file: audioFile(MAX_INLINE_BYTES + 1) }),
  )).toBe(true)
})

test('a Gemini candidate is judged by its adapter, whatever flavor it carries', () => {
  // The registry gives every gemini-adapter provider the translated
  // `transcribe`, ignoring the flavor label entirely — so a flavor-first
  // ordering here would call this candidate unable to transcribe at all.
  const gemini = candidate('gemini', 'anthropic_messages')

  expect(ingress.supports?.(gemini, req({ response_format: 'json' }))).toBe(true)
  expect(ingress.supports?.(gemini, req({ response_format: 'srt' }))).toBe(false)
})

test('OpenAI-shaped candidates serve every format', () => {
  for (const adapter of ['openai', 'openai_compatible']) {
    for (const flavor of ['chat_completions', 'responses']) {
      for (const format of ['json', 'verbose_json', 'text', 'srt', 'vtt'] as TranscriptionFormat[]) {
        expect(ingress.supports?.(candidate(adapter, flavor), req({ response_format: format }))).toBe(true)
      }
    }
  }
})

// --- droppedFor ------------------------------------------------------------

test('reports what a Gemini target cannot express', () => {
  const dropped = ingress.droppedFor(
    candidate('gemini', 'chat_completions'),
    req({ include: ['logprobs'], keywords: ['acme'] }),
  )

  expect(dropped).toEqual(['include', 'keywords'])
})

test('an OpenAI-shaped target is sent the request as it arrived', () => {
  expect(ingress.droppedFor(
    candidate('openai', 'chat_completions'),
    req({ include: ['logprobs'], keywords: ['acme'] }),
  )).toEqual([])
})

test('reports a pinned service tier as dropped, whatever the target', () => {
  // This dialect has no `service_tier` field, so a tier the operator pinned on
  // the target cannot be honoured — and an operator's routing decision the
  // gateway silently ignores is exactly what this header exists to surface.
  expect(ingress.droppedFor(tiered('openai', 'chat_completions'), req()))
    .toEqual(['service_tier'])
  expect(ingress.droppedFor(tiered('gemini', 'chat_completions'), req({ keywords: ['acme'] })))
    .toEqual(['keywords', 'service_tier'])
})

test('injects nothing per target, so no tier reaches the upstream form', () => {
  // No `bodyFor` at all: the handler's default hands the client's own request
  // to every candidate. A `service_tier` added here would be spread into the
  // multipart form by the OpenAI adapter and rejected upstream as an unknown
  // parameter — a request that was going to succeed, failed by a routing
  // setting that has no meaning on this endpoint.
  expect(ingress.bodyFor).toBeUndefined()
})

// --- usageOf ---------------------------------------------------------------

test('maps token-billed usage onto the log shape', () => {
  expect(ingress.usageOf({
    text: 'hi',
    usage: { type: 'tokens', input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  } as TranscriptionResult)).toEqual({
    promptTokens: 12, completionTokens: 4, cachedTokens: null, reasoningTokens: null,
  })
})

test('reports no usage for a duration-billed response', () => {
  // Never `{ promptTokens: 9 }`: seconds in a token column would corrupt
  // every rollup that sums tokens (design doc §3.8).
  expect(ingress.usageOf({
    text: 'hi', usage: { type: 'duration', seconds: 9 },
  } as TranscriptionResult)).toBeNull()
})

test('reports no usage for a text-format response', () => {
  expect(ingress.usageOf('hello there')).toBeNull()
})

// --- finish ----------------------------------------------------------------

test('attaches the cost to a token-billed response', () => {
  const finished = ingress.finish(
    { text: 'hi', usage: { type: 'tokens', input_tokens: 12, output_tokens: 4, total_tokens: 16 } } as TranscriptionResult,
    identity,
    cost,
  )

  expect(finished).toEqual({
    text: 'hi',
    usage: { type: 'tokens', input_tokens: 12, output_tokens: 4, total_tokens: 16, cost },
  })
})

test('reports a duration-billed response as unpriced rather than free', () => {
  const finished = ingress.finish(
    { text: 'hi', usage: { type: 'duration', seconds: 9 } } as TranscriptionResult,
    identity,
    null,
  )

  expect(finished).toEqual({ text: 'hi', usage: { type: 'duration', seconds: 9, cost: null } })
})

test('returns a text-format result untouched', () => {
  expect(ingress.finish('1\n00:00:00,000 --> 00:00:01,000\nhi\n', identity, cost))
    .toBe('1\n00:00:00,000 --> 00:00:01,000\nhi\n')
})

test('mints no response id of its own', () => {
  expect(ingress.newIdentityId).toBeUndefined()
})

test('declares no streaming members', () => {
  expect(ingress.runStream).toBeUndefined()
  expect(ingress.stream).toBeUndefined()
  expect(ingress.captureResponse).toBeUndefined()
})

// --- toResponse ------------------------------------------------------------

test('renders the two JSON formats as JSON', async () => {
  const json = ingress.toResponse({ text: 'hi' } as TranscriptionResult, { 'x-request-id': 'r1' })
  expect(json.headers.get('content-type')).toBe('application/json')
  expect(json.headers.get('x-request-id')).toBe('r1')
  expect(await json.json()).toEqual({ text: 'hi' })

  const verbose = ingress.toResponse(
    { text: 'hi', duration: 1, language: 'en', segments: [] } as TranscriptionResult,
    {},
  )
  expect(verbose.headers.get('content-type')).toBe('application/json')
})

test('renders text, srt and vtt as plain text, with the attempt headers merged in', async () => {
  // One content type for all three: it is what the upstream API sends, and the
  // OpenAI SDK decides how to parse by asking whether the type is
  // application/json (design doc §3.3).
  for (const body of ['hi', '1\n00:00:00,000 --> 00:00:01,000\nhi\n', 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n']) {
    const response = ingress.toResponse(body, { 'x-babellm-provider': 'groq' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('x-babellm-provider')).toBe('groq')
    // Not JSON-quoted: an srt client handed `"WEBVTT\n\n…"` is broken in a way
    // no amount of leniency fixes.
    expect(await response.text()).toBe(body)
  }
})

// --- captureRequest -------------------------------------------------------

test('captures the form fields and the file metadata, never the audio', () => {
  const captured = ingress.captureRequest?.(req({
    file: audioFile(2048, 'meeting.wav', 'audio/wav'),
    language: 'en',
    prompt: 'ACME Corp',
    temperature: 0.2,
  }))

  expect(captured).toEqual({
    model: 'whisper-1',
    response_format: 'json',
    language: 'en',
    prompt: 'ACME Corp',
    temperature: 0.2,
    file: { name: 'meeting.wav', size: 2048, type: 'audio/wav' },
  })
  // The exact-shape assertion above is the whole proof: the record holds those
  // fields and nothing else, so there is no `File` in it and no route by which
  // audio could reach a stored row (design doc §3.10). What a *row* actually
  // contains is Task 9's, where there is a real one to inspect.
})

test('describes any File-valued field, not just the one named `file`', () => {
  // The schema is a `looseObject`, so an unrecognized part reaches the captured
  // record. A key-name substitution would store this one as `{}` — the shape
  // `JSON.stringify` gives a `File` — which leaks nothing but loses the
  // metadata that makes a captured row worth reading. Matching on the value
  // keeps the guarantee (no audio bytes, ever) true by construction for a part
  // this ingress has never heard of.
  const captured = ingress.captureRequest?.({
    ...req(),
    stray_upload: audioFile(4096, 'second-take.ogg', 'audio/ogg'),
  } as unknown as TranscriptionRequest) as Record<string, unknown>

  expect(captured.stray_upload).toEqual({ name: 'second-take.ogg', size: 4096, type: 'audio/ogg' })
  expect(captured.file).toEqual({ name: 'clip.mp3', size: 1024, type: 'audio/mpeg' })
  expect(Object.values(captured).some((value) => value instanceof File)).toBe(false)
})
