import { afterEach, expect, test, vi } from 'vitest'
import { BedrockRuntimeClient, ConverseCommand, type BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime'
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock'
import { createBedrockAdapter } from '@/lib/adapters/bedrock'
import { createBedrockRuntimeClient, createBedrockControlClient } from '@/lib/adapters/bedrock/client'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = { id: 'b', name: 'aws', adapter: 'bedrock', baseUrl: null,
  credentials: { region: 'eu-west-1', accessKeyId: 'FAKEKEY', secretAccessKey: 'fake-secret', sessionToken: 'fake-session' }, config: {} }
const ctx = { upstreamModel: 'vendor.model:0', signal: new AbortController().signal, requestId: 'r' }
const req = { model: 'public', messages: [{ role: 'user' as const, content: 'hello' }] }
const answer = { output: { message: { role: 'assistant', content: [{ text: 'hi' }] } }, stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
afterEach(() => vi.unstubAllEnvs())

test('real SDK signs IAM requests despite an ambient bearer token, serializes Converse and uses only runtime endpoint override', async () => {
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'must-not-be-sent')
  const seen: { path: string; hostname: string; headers: Record<string, string>; body?: unknown }[] = []
  const handler = { handle: async (request: typeof seen[number]) => {
    seen.push(request)
    return { response: { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(answer)) } }
  } }
  const client = createBedrockRuntimeClient({ ...runtime, baseUrl: 'https://runtime.example.test' }, (options) => new BedrockRuntimeClient({ ...options, requestHandler: handler }))
  await client.send(new ConverseCommand({ modelId: 'vendor.model:0', messages: [{ role: 'user', content: [{ text: 'hello' }] }] }))
  const control = createBedrockControlClient({ ...runtime, baseUrl: 'https://runtime.example.test' }, (options) => new BedrockClient({ ...options, requestHandler: handler }))
  await control.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }))
  expect(seen[0].hostname).toBe('runtime.example.test')
  expect(seen[0].path).toBe('/model/vendor.model%3A0/converse')
  expect(JSON.parse(String(seen[0].body))).toMatchObject({ messages: [{ role: 'user', content: [{ text: 'hello' }] }] })
  for (const request of seen) {
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=FAKEKEY\//)
    expect(request.headers['x-amz-security-token']).toBe('fake-session')
  }
  expect(seen[1].hostname).toBe('bedrock.eu-west-1.amazonaws.com')
  client.destroy(); control.destroy()
})

test('construction is lazy, validates region and leaves default credentials absent', async () => {
  const configs: BedrockRuntimeClientConfig[] = []
  const factory = (options: BedrockRuntimeClientConfig) => { configs.push(options); return new BedrockRuntimeClient(options) }
  const client = createBedrockRuntimeClient({ ...runtime, credentials: { region: 'us-east-1', useInstanceRole: true } }, factory)
  expect(configs[0]).toMatchObject({ region: 'us-east-1', maxAttempts: 1, authSchemePreference: ['sigv4'] })
  expect(configs[0]).not.toHaveProperty('credentials')
  expect(() => createBedrockRuntimeClient({ ...runtime, credentials: {} })).toThrow(/region/i)
  expect(() => createBedrockRuntimeClient({ ...runtime, credentials: { region: 'us-east-1', accessKeyId: 'half' } })).toThrow(/secretAccessKey/i)
  client.destroy()
})

test('real AWS error deserialization preserves throttle and does not retry inside SDK', async () => {
  let calls = 0
  const adapter = createBedrockAdapter(runtime, { runtime: (options) => new BedrockRuntimeClient({ ...options,
    requestHandler: { handle: async () => { calls++; return { response: { statusCode: 429, headers: { 'x-amzn-errortype': 'ThrottlingException' }, body: Buffer.from('{"message":"capacity exhausted"}') } } } },
  }) })
  await expect(adapter.chat(req, ctx)).rejects.toMatchObject({ status: 429, code: 'ThrottlingException', message: 'capacity exhausted', retryable: true })
  expect(calls).toBe(1)
})

test.each(['caller', 'timeout'])('adapter passes %s abort through to in-flight operation', async (kind) => {
  const controller = new AbortController()
  let passedSignal: AbortSignal | undefined
  const adapter = createBedrockAdapter({ ...runtime, config: { timeoutMs: 15 } }, { runtime: () => ({ send: async (_command: unknown, options: { abortSignal: AbortSignal }) => {
    passedSignal = options.abortSignal
    await new Promise((_, reject) => options.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }))
  } }) as unknown as BedrockRuntimeClient })
  const pending = adapter.chat(req, { ...ctx, signal: controller.signal })
  if (kind === 'caller') controller.abort()
  await expect(pending).rejects.toMatchObject({ status: 504, retryable: true })
  expect(passedSignal?.aborted).toBe(true)
})

test('stream exceptions retain their classification and plain request validation retains the client parameter', async () => {
  async function* stream() { yield { throttlingException: { message: 'stream overloaded' } } }
  const adapter = createBedrockAdapter(runtime, { runtime: () => ({ send: async () => ({ stream: stream() }) }) as unknown as BedrockRuntimeClient })
  await expect(Array.fromAsync(adapter.chatStream(req, ctx))).rejects.toMatchObject({ status: 429, code: 'throttlingException', retryable: true })
  await expect(adapter.chat({ ...req, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,%%%' } }] }] }, ctx)).rejects.toMatchObject({ status: 400, param: expect.stringContaining('messages') })
})

test('total timeout continues into stream consumption after the opening operation returns', async () => {
  const adapter = createBedrockAdapter({ ...runtime, config: { timeoutMs: 15 } }, { runtime: () => ({
    send: async (_command: unknown, options: { abortSignal: AbortSignal }) => ({ stream: (async function* () {
      yield { messageStart: { role: 'assistant' } }
      await new Promise((_, reject) => options.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('stream timeout'), { name: 'AbortError' })), { once: true }))
    })() }),
  }) as unknown as BedrockRuntimeClient })
  await expect(Array.fromAsync(adapter.chatStream(req, ctx))).rejects.toMatchObject({ status: 504, retryable: true })
})

test('timeout after messageStop rejects even when the SDK stream ends normally on abort', async () => {
  const chunks: { choices: { finish_reason: string | null }[] }[] = []
  const adapter = createBedrockAdapter({ ...runtime, config: { timeoutMs: 15 } }, { runtime: () => ({
    send: async (_command: unknown, options: { abortSignal: AbortSignal }) => ({ stream: (async function* () {
      yield { messageStart: { role: 'assistant' } }
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hello' } } }
      yield { contentBlockStop: { contentBlockIndex: 0 } }
      yield { messageStop: { stopReason: 'end_turn' } }
      // Smithy's HTTP/2 abort path can close the already-resolved response
      // stream normally, so this must not simulate an iterator rejection.
      await new Promise<void>((resolve) => options.abortSignal.addEventListener('abort', () => resolve(), { once: true }))
    })() }),
  }) as unknown as BedrockRuntimeClient })
  const consume = async () => { for await (const chunk of adapter.chatStream(req, ctx)) chunks.push(chunk) }
  await expect(consume()).rejects.toMatchObject({ status: 504, retryable: true })
  expect(chunks.some((chunk) => chunk.choices.some((choice) => choice.finish_reason !== null))).toBe(false)
})
