import { expect, test } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import { GatewayError, ProviderError } from '@/lib/gateway/errors'
import type { TranscriptionRequest } from '@/lib/schemas/transcription'
import {
  MAX_INLINE_BYTES,
  assertTranscribable,
  droppedParams,
  fromGenerateContent,
  toGeminiRequest,
} from '@/lib/translate/transcription-to-gemini'

function file(bytes: number, name = 'clip.mp3', type = 'audio/mpeg') {
  return new File([new Uint8Array(bytes)], name, { type })
}

function req(partial: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
  return {
    file: file(1024),
    model: 'gemini-2.5-flash',
    response_format: 'json',
    ...partial,
  }
}

function response(partial: Record<string, unknown>): GenerateContentResponse {
  // GenerateContentResponse is a class with derived accessors the fixtures
  // below never populate — see the same cast in chat-to-gemini-response.test.ts.
  return partial as unknown as GenerateContentResponse
}

// --- assertTranscribable ----------------------------------------------------

test('allows json and text formats', () => {
  expect(() => assertTranscribable(req({ response_format: 'json' }), 'gemini')).not.toThrow()
  expect(() => assertTranscribable(req({ response_format: 'text' }), 'gemini')).not.toThrow()
})

for (const format of ['verbose_json', 'srt', 'vtt'] as const) {
  test(`refuses ${format} with a 400 naming the provider`, () => {
    expect(() => assertTranscribable(req({ response_format: format }), 'gemini')).toThrow(
      GatewayError,
    )
    try {
      assertTranscribable(req({ response_format: format }), 'gemini')
      throw new Error('expected assertTranscribable to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError)
      const gatewayErr = err as GatewayError
      expect(gatewayErr.status).toBe(400)
      expect(gatewayErr.message).toContain('gemini')
      expect(gatewayErr.message.toLowerCase()).toContain('timestamp')
    }
  })
}

test('refuses audio that would exceed the inline ceiling, naming the limit', () => {
  const big = req({ file: file(MAX_INLINE_BYTES + 1) })
  try {
    assertTranscribable(big, 'gemini')
    throw new Error('expected assertTranscribable to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(GatewayError)
    const gatewayErr = err as GatewayError
    expect(gatewayErr.status).toBe(400)
    expect(gatewayErr.message).toContain('20')
    expect(gatewayErr.message.toLowerCase()).toContain('openai')
  }
})

test('allows a file exactly at the inline ceiling', () => {
  expect(() => assertTranscribable(req({ file: file(MAX_INLINE_BYTES) }), 'gemini')).not.toThrow()
})

test('the ceiling is refused before the file is ever read', async () => {
  const oversized = file(MAX_INLINE_BYTES + 1)
  const arrayBuffer = oversized.arrayBuffer.bind(oversized)
  let read = false
  oversized.arrayBuffer = async () => {
    read = true
    return arrayBuffer()
  }

  expect(() => assertTranscribable(req({ file: oversized }), 'gemini')).toThrow(GatewayError)
  expect(read).toBe(false)
})

// --- toGeminiRequest ---------------------------------------------------------

test('mime type comes from the uploaded part when it is a real audio type', async () => {
  const params = await toGeminiRequest(
    req({ file: file(4, 'clip.bin', 'audio/mpeg') }),
    'gemini-2.5-flash',
    {},
  )
  const parts = params.contents as { role: string; parts: { inlineData?: { mimeType: string } }[] }[]
  expect(parts[0].parts[0].inlineData?.mimeType).toBe('audio/mpeg')
})

test('a video container type is accepted, since its audio track transcribes', async () => {
  const params = await toGeminiRequest(
    req({ file: file(4, 'clip.mov', 'video/quicktime') }),
    'gemini-2.5-flash',
    {},
  )
  const parts = params.contents as { role: string; parts: { inlineData?: { mimeType: string } }[] }[]
  expect(parts[0].parts[0].inlineData?.mimeType).toBe('video/quicktime')
})

for (const [name, mime] of [
  ['clip.mp3', 'audio/mpeg'],
  ['clip.wav', 'audio/wav'],
  ['clip.m4a', 'audio/m4a'],
  ['clip.ogg', 'audio/ogg'],
  ['clip.flac', 'audio/flac'],
  ['clip.webm', 'video/webm'],
] as const) {
  test(`mime type falls back to the ${name} extension when the type is absent`, async () => {
    const params = await toGeminiRequest(
      req({ file: file(4, name, '') }),
      'gemini-2.5-flash',
      {},
    )
    const parts = params.contents as { role: string; parts: { inlineData?: { mimeType: string } }[] }[]
    expect(parts[0].parts[0].inlineData?.mimeType).toBe(mime)
  })

  test(`mime type falls back to the ${name} extension when the type is application/octet-stream`, async () => {
    const params = await toGeminiRequest(
      req({ file: file(4, name, 'application/octet-stream') }),
      'gemini-2.5-flash',
      {},
    )
    const parts = params.contents as { role: string; parts: { inlineData?: { mimeType: string } }[] }[]
    expect(parts[0].parts[0].inlineData?.mimeType).toBe(mime)
  })
}

test('a type that cannot be determined is a 400, not a guess', async () => {
  await expect(
    toGeminiRequest(req({ file: file(4, 'clip.xyz', '') }), 'gemini-2.5-flash', {}),
  ).rejects.toThrow(ProviderError)
  await expect(
    toGeminiRequest(req({ file: file(4, 'clip.xyz', '') }), 'gemini-2.5-flash', {}),
  ).rejects.toMatchObject({ status: 400 })
})

test('the instruction asks for a verbatim transcription with nothing else', async () => {
  const params = await toGeminiRequest(req(), 'gemini-2.5-flash', {})
  const parts = params.contents as { role: string; parts: { text?: string }[] }[]
  const instruction = parts[0].parts[1].text ?? ''
  expect(instruction.toLowerCase()).toContain('verbatim')
  expect(instruction.toLowerCase()).toContain('do not summarize')
})

test('the instruction names the language when the client sent one, without translating', async () => {
  const params = await toGeminiRequest(req({ language: 'French' }), 'gemini-2.5-flash', {})
  const parts = params.contents as { role: string; parts: { text?: string }[] }[]
  const instruction = parts[0].parts[1].text ?? ''
  expect(instruction).toContain('French')
})

test('the instruction has no language framing when none was sent', async () => {
  const params = await toGeminiRequest(req(), 'gemini-2.5-flash', {})
  const parts = params.contents as { role: string; parts: { text?: string }[] }[]
  const instruction = parts[0].parts[1].text ?? ''
  expect(instruction).not.toContain('The audio is in')
})

test('the prompt is framed as context, not folded into the transcript instruction as content', async () => {
  const params = await toGeminiRequest(
    req({ prompt: 'Acme Corp, ACME-42' }),
    'gemini-2.5-flash',
    {},
  )
  const parts = params.contents as { role: string; parts: { text?: string }[] }[]
  const instruction = parts[0].parts[1].text ?? ''
  expect(instruction).toContain('Acme Corp, ACME-42')
  expect(instruction.toLowerCase()).toContain('context')
  expect(instruction.toLowerCase()).toContain('not part of the audio')
})

test('no prompt means no context framing', async () => {
  const params = await toGeminiRequest(req(), 'gemini-2.5-flash', {})
  const parts = params.contents as { role: string; parts: { text?: string }[] }[]
  const instruction = parts[0].parts[1].text ?? ''
  expect(instruction.toLowerCase()).not.toContain('context')
})

test('the inline part carries the base64 of exactly the bytes uploaded', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 250, 251])
  const upload = new File([bytes], 'clip.mp3', { type: 'audio/mpeg' })
  const params = await toGeminiRequest(req({ file: upload }), 'gemini-2.5-flash', {})
  const parts = params.contents as { role: string; parts: { inlineData?: { data: string } }[] }[]
  const data = parts[0].parts[0].inlineData?.data ?? ''
  expect(Buffer.from(data, 'base64')).toEqual(Buffer.from(bytes))
})

test('temperature reaches the generation config', async () => {
  const params = await toGeminiRequest(req({ temperature: 0.4 }), 'gemini-2.5-flash', {})
  expect(params.config?.temperature).toBe(0.4)
})

test('temperature is omitted from the config when the client did not send one', async () => {
  const params = await toGeminiRequest(req(), 'gemini-2.5-flash', {})
  expect(params.config?.temperature).toBeUndefined()
})

test('the model id passed through becomes the request model', async () => {
  const params = await toGeminiRequest(req(), 'gemini-2.5-flash-001', {})
  expect(params.model).toBe('gemini-2.5-flash-001')
})

// --- fromGenerateContent -----------------------------------------------------

test('json format returns { text }', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'hello world' }] } }] }),
    req({ response_format: 'json' }),
  )
  expect(result).toEqual({ text: 'hello world' })
})

test('text format returns the bare string', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'hello world' }] } }] }),
    req({ response_format: 'text' }),
  )
  expect(result).toBe('hello world')
})

test('multiple text parts are concatenated', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }] }),
    req({ response_format: 'text' }),
  )
  expect(result).toBe('hello world')
})

test('no candidates is a retryable 502 ProviderError', () => {
  try {
    fromGenerateContent(response({ candidates: [] }), req())
    throw new Error('expected fromGenerateContent to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError)
    const providerErr = err as ProviderError
    expect(providerErr.status).toBe(502)
    expect(providerErr.retryable).toBe(true)
  }
})

test('a candidate with no text is a retryable 502 ProviderError', () => {
  expect(() =>
    fromGenerateContent(response({ candidates: [{ content: { parts: [] } }] }), req()),
  ).toThrow(ProviderError)
})

test('a candidate with only a functionCall part counts as no text', () => {
  expect(() =>
    fromGenerateContent(
      response({ candidates: [{ content: { parts: [{ functionCall: { name: 'x', args: {} } }] } }] }),
      req(),
    ),
  ).toThrow(ProviderError)
})

// --- droppedParams ------------------------------------------------------------

test('reports include, chunking_strategy, keywords and languages when present', () => {
  expect(
    droppedParams(
      req({
        include: ['logprobs'],
        chunking_strategy: 'auto',
        keywords: ['acme'],
        languages: ['en'],
      }),
    ),
  ).toEqual(['include', 'chunking_strategy', 'keywords', 'languages'])
})

test('reports nothing when none of those fields were sent', () => {
  expect(droppedParams(req())).toEqual([])
})

test('never reports timestamp_granularities', () => {
  expect(
    droppedParams(
      req({ response_format: 'verbose_json', timestamp_granularities: ['segment'] }),
    ),
  ).not.toContain('timestamp_granularities')
})
