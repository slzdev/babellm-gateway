import { expect, test } from 'vitest'
import { GatewayError } from '@/lib/gateway/errors'
import { parseWith } from '@/lib/gateway/handler'
import {
  MAX_FILE_BYTES,
  transcriptionFromForm,
  transcriptionRequestSchema,
} from '@/lib/schemas/transcription'

function audioFile(bytes: number, name = 'clip.mp3', type = 'audio/mpeg') {
  return new File([new Uint8Array(bytes)], name, { type })
}

const minimal = { file: audioFile(1024), model: 'whisper-1' }

test('accepts a minimal request and defaults response_format to json', () => {
  const parsed = transcriptionRequestSchema.parse(minimal)
  expect(parsed.model).toBe('whisper-1')
  expect(parsed.response_format).toBe('json')
  expect(parsed.file).toBeInstanceOf(File)
})

test('requires a file', () => {
  const result = transcriptionRequestSchema.safeParse({ model: 'whisper-1' })
  expect(result.success).toBe(false)
  expect(result.error?.issues[0]?.path).toEqual(['file'])
})

test('rejects a string in place of the file, naming the field', () => {
  const result = transcriptionRequestSchema.safeParse({ ...minimal, file: 'not-a-file' })
  expect(result.success).toBe(false)
  expect(result.error?.issues[0]?.path).toEqual(['file'])
})

test('rejects a file over the 25 MB cap, naming the limit', () => {
  const result = transcriptionRequestSchema.safeParse({
    ...minimal,
    file: audioFile(26 * 1024 * 1024),
  })
  expect(result.success).toBe(false)
  const issue = result.error?.issues[0]
  expect(issue?.path).toEqual(['file'])
  expect(issue?.message).toMatch(/25 ?MB/)
})

test('accepts a file just under the cap and rejects one just over it', () => {
  expect(transcriptionRequestSchema.safeParse({ ...minimal, file: audioFile(24 * 1024 * 1024) }).success).toBe(true)
  expect(transcriptionRequestSchema.safeParse({ ...minimal, file: audioFile(MAX_FILE_BYTES + 1) }).success).toBe(false)
  expect(transcriptionRequestSchema.safeParse({ ...minimal, file: audioFile(MAX_FILE_BYTES) }).success).toBe(true)
})

test('requires a model', () => {
  const result = transcriptionRequestSchema.safeParse({ file: audioFile(1024) })
  expect(result.success).toBe(false)
  expect(result.error?.issues[0]?.path).toEqual(['model'])
})

test('coerces temperature from a form string', () => {
  const parsed = transcriptionRequestSchema.parse({ ...minimal, temperature: '0.2' })
  expect(parsed.temperature).toBe(0.2)
})

test('rejects a temperature outside 0-1', () => {
  const result = transcriptionRequestSchema.safeParse({ ...minimal, temperature: '1.5' })
  expect(result.success).toBe(false)
  expect(result.error?.issues[0]?.path).toEqual(['temperature'])
})

test('rejects a response_format outside the five, naming them', () => {
  const result = transcriptionRequestSchema.safeParse({ ...minimal, response_format: 'diarized_json' })
  expect(result.success).toBe(false)
  const message = result.error?.issues[0]?.message ?? ''
  for (const format of ['json', 'verbose_json', 'text', 'srt', 'vtt']) {
    expect(message).toContain(format)
  }
})

test('accepts each of the five response formats', () => {
  for (const format of ['json', 'verbose_json', 'text', 'srt', 'vtt']) {
    expect(transcriptionRequestSchema.safeParse({ ...minimal, response_format: format }).success).toBe(true)
  }
})

test('timestamp_granularities requires response_format: verbose_json, naming both fields', () => {
  const result = transcriptionRequestSchema.safeParse({
    ...minimal,
    response_format: 'json',
    timestamp_granularities: ['word'],
  })
  expect(result.success).toBe(false)
  const issue = result.error?.issues[0]
  expect(issue?.path).toEqual(['timestamp_granularities'])
  expect(issue?.message).toContain('timestamp_granularities')
  expect(issue?.message).toContain('response_format')
  expect(issue?.message).toContain('verbose_json')
})

test('timestamp_granularities is accepted alongside verbose_json', () => {
  const parsed = transcriptionRequestSchema.parse({
    ...minimal,
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
  })
  expect(parsed.timestamp_granularities).toEqual(['word', 'segment'])
})

test("stream: 'true' is refused as a GatewayError naming stream and how to retry", () => {
  let thrown: unknown
  try {
    transcriptionRequestSchema.parse({ ...minimal, stream: 'true' })
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(GatewayError)
  const err = thrown as GatewayError
  expect(err.status).toBe(400)
  expect(err.code).toBe('unsupported_parameter')
  expect(err.param).toBe('stream')
  expect(err.message).toMatch(/retry.*without.*stream/i)
})

test("stream: 'false' is accepted and does not appear on the parsed request", () => {
  const parsed = transcriptionRequestSchema.parse({ ...minimal, stream: 'false' })
  expect((parsed as unknown as Record<string, unknown>).stream).toBeUndefined()
})

test('rejects an unparseable stream value the ordinary way, not as the streaming refusal', () => {
  const result = transcriptionRequestSchema.safeParse({ ...minimal, stream: 'yes' })
  expect(result.success).toBe(false)
  expect(result.error?.issues[0]?.path).toEqual(['stream'])
})

test('chunking_strategy accepts "auto"', () => {
  const parsed = transcriptionRequestSchema.parse({ ...minimal, chunking_strategy: 'auto' })
  expect(parsed.chunking_strategy).toBe('auto')
})

test('chunking_strategy accepts a JSON object', () => {
  const parsed = transcriptionRequestSchema.parse({
    ...minimal,
    chunking_strategy: JSON.stringify({ type: 'server_vad', prefix_padding_ms: 300 }),
  })
  expect(parsed.chunking_strategy).toEqual({ type: 'server_vad', prefix_padding_ms: 300 })
})

test('chunking_strategy rejects a non-auto string that is not JSON', () => {
  const result = transcriptionRequestSchema.safeParse({ ...minimal, chunking_strategy: 'sometimes' })
  expect(result.success).toBe(false)
  expect(result.error?.issues[0]?.path).toEqual(['chunking_strategy'])
})

test('keeps unknown fields so they reach the provider', () => {
  const parsed = transcriptionRequestSchema.parse({ ...minimal, some_new_field: 'x' })
  expect((parsed as unknown as Record<string, unknown>).some_new_field).toBe('x')
})

test('errors flow through parseWith with the standard envelope fields', () => {
  let thrown: unknown
  try {
    parseWith(transcriptionRequestSchema, { model: 'whisper-1' })
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(GatewayError)
  const err = thrown as GatewayError
  expect(err.status).toBe(400)
  expect(err.type).toBe('invalid_request_error')
  expect(err.param).toBe('file')
})

test('the stream refusal also comes back through parseWith unchanged', () => {
  let thrown: unknown
  try {
    parseWith(transcriptionRequestSchema, { ...minimal, stream: 'true' })
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(GatewayError)
  expect((thrown as GatewayError).code).toBe('unsupported_parameter')
})

test('transcriptionFromForm strips the trailing [] and collapses repeats into an array', () => {
  const form = new FormData()
  form.append('model', 'whisper-1')
  form.append('timestamp_granularities[]', 'word')
  form.append('timestamp_granularities[]', 'segment')

  const result = transcriptionFromForm(form) as Record<string, unknown>
  expect(result.timestamp_granularities).toEqual(['word', 'segment'])
  expect(result).not.toHaveProperty('timestamp_granularities[]')
})

test('transcriptionFromForm keeps a single value under a non-repeated key', () => {
  const form = new FormData()
  form.append('model', 'whisper-1')
  form.append('temperature', '0.2')

  const result = transcriptionFromForm(form) as Record<string, unknown>
  expect(result.model).toBe('whisper-1')
  expect(result.temperature).toBe('0.2')
})

test('transcriptionFromForm passes the File through untouched', () => {
  const file = audioFile(1024)
  const form = new FormData()
  form.append('file', file)
  form.append('model', 'whisper-1')

  const result = transcriptionFromForm(form) as Record<string, unknown>
  expect(result.file).toBe(file)
})

test('a normalized multipart body round-trips through the schema end to end', () => {
  const form = new FormData()
  form.append('file', audioFile(2048))
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0.4')
  form.append('timestamp_granularities[]', 'word')
  form.append('timestamp_granularities[]', 'segment')
  form.append('include[]', 'logprobs')
  form.append('languages[]', 'en')
  form.append('languages[]', 'fr')
  form.append('keywords[]', 'babellm')

  const parsed = transcriptionRequestSchema.parse(transcriptionFromForm(form))
  expect(parsed).toMatchObject({
    model: 'whisper-1',
    response_format: 'verbose_json',
    temperature: 0.4,
    timestamp_granularities: ['word', 'segment'],
    include: ['logprobs'],
    languages: ['en', 'fr'],
    keywords: ['babellm'],
  })
  expect(parsed.file).toBeInstanceOf(File)
})
