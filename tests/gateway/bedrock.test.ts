import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { handleResponses } from '@/lib/gateway/responses-handler'
import { handleEmbeddings } from '@/lib/gateway/embeddings-handler'
import { runGatewayRequest } from '@/lib/gateway/handler'
import { transcriptionIngress } from '@/lib/gateway/protocols/transcription'
import { db } from '@/lib/db'
import { catalogModels, providers } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { encryptJson } from '@/lib/crypto'
import { clearPriceCache } from '@/lib/pricing'
import * as logs from '@/lib/logs'
const writeLog = logs.logRequest
let pendingLogs: Promise<void>[] = []
import { resetDb } from '../helpers/db'
import { chatRequest, responsesRequest, embeddingsRequest, fakeAdapterByProvider, seedGateway, seedTargets, seedPrices } from '../helpers/gateway'

const credentials = { region: 'us-east-1', accessKeyId: 'FAKE', secretAccessKey: 'fake' }
const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }
const answer = { output: { message: { role: 'assistant', content: [{ text: 'from AWS' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 } }
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'b'.repeat(64)
  await resetDb(); clearPriceCache()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  pendingLogs = []
  vi.spyOn(logs, 'logRequest').mockImplementation((entry) => { const pending = writeLog(entry); pendingLogs.push(pending); return pending })
})
afterEach(async () => { await Promise.all(pendingLogs); vi.restoreAllMocks() })

test.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('Chat uses Converse under the %s label and reports drops/cost', async (apiFlavor) => {
  const seed = await seedGateway({ adapter: 'bedrock', credentials, apiFlavor, upstreamModel: 'us.vendor.model' })
  await seedPrices(seed.provider.id, 'us.vendor.model', { inputPerMtok: '1', outputPerMtok: '3' })
  const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue(answer as never)
  const res = await handleChatCompletions(chatRequest({ ...body, reasoning_effort: 'high' }, seed.apiKey))
  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-dropped-params')).toContain('reasoning_effort')
  const json = await res.json()
  expect(json.choices[0].message.content).toBe('from AWS')
  expect(json.model).toBe('house-model')
  expect(json.usage.cost.total).toBe('4.000000000')
  expect(send.mock.calls[0][0]).toMatchObject({ input: { modelId: 'us.vendor.model', messages: [{ role: 'user', content: [{ text: 'hi' }] }] } })
  expect(send.mock.calls[0][0].constructor.name).toBe('ConverseCommand')
})

test.each(['chat_completions', 'responses'] as const)('Responses translates through Chat for %s flavor and reports discarded fields', async (apiFlavor) => {
  const { apiKey } = await seedGateway({ adapter: 'bedrock', credentials, apiFlavor })
  vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue(answer as never)
  const res = await handleResponses(responsesRequest({ model: 'house-model', input: 'hi', metadata: { source: 'client' } }, apiKey))
  expect(res.status).toBe(200)
  expect((await res.json()).output[0].content[0].text).toBe('from AWS')
  expect(res.headers.get('x-babellm-dropped-params')).toContain('metadata')
})

test('streams metadata usage after stop, with normalized tokens and cost', async () => {
  const seed = await seedGateway({ adapter: 'bedrock', credentials })
  await seedPrices(seed.provider.id, seed.upstreamModel, { inputPerMtok: '1', outputPerMtok: '3' })
  async function* stream() {
    yield { messageStart: { role: 'assistant' } }
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hello' } } }
    yield { contentBlockStop: { contentBlockIndex: 0 } }
    yield { messageStop: { stopReason: 'end_turn' } }
    yield { metadata: { usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 } } }
  }
  const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue({ stream: stream() } as never)
  const res = await handleChatCompletions(chatRequest({ ...body, stream: true, stream_options: { include_usage: true } }, seed.apiKey))
  const text = await res.text()
  expect(text).toContain('"content":"hello"')
  expect(text).toContain('"prompt_tokens":1000000')
  expect(text).toContain('"total":"4.000000000"')
  expect(text).toContain('[DONE]')
  expect(send.mock.calls[0][0].constructor.name).toBe('ConverseStreamCommand')
})

test('direct catalog addresses preserve profile ARN unchanged', async () => {
  const arn = 'arn:aws:bedrock:us-east-1:123:application-inference-profile/app'
  const seed = await seedGateway({ adapter: 'bedrock', credentials })
  await db.insert(catalogModels).values({ providerId: seed.provider.id, modelId: arn })
  const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue(answer as never)
  const address = `test-provider/${arn}`
  const res = await handleChatCompletions(chatRequest({ ...body, model: address }, seed.apiKey))
  expect(res.status).toBe(200)
  expect((await res.json()).model).toBe(address)
  expect(send.mock.calls[0][0]).toMatchObject({ input: { modelId: arn } })
})

test('transient AWS failure fails over once without SDK retry', async () => {
  const seed = await seedTargets({ targets: [{ name: 'aws1', adapter: 'bedrock', priority: 0 }, { name: 'aws2', adapter: 'bedrock', priority: 1 }] })
  for (const target of seed.targets) await db.update(providers).set({ credentials: encryptJson(credentials) }).where(eq(providers.id, target.provider.id))
  const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'ThrottlingException' })).mockResolvedValueOnce(answer as never)
  const res = await handleChatCompletions(chatRequest(body, seed.apiKey))
  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('aws2')
  expect(send).toHaveBeenCalledTimes(2)
})

function transcriptionRequest(apiKey: string) {
  const data = new FormData(); data.set('model', 'house-model'); data.set('file', new File(['audio'], 'clip.wav', { type: 'audio/wav' }))
  return new Request('http://gateway.test/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: data })
}
test.each(['embed', 'transcribe'] as const)('Bedrock-only %s refuses with 501 without an AWS request', async (operation) => {
  const { apiKey } = await seedGateway({ adapter: 'bedrock', credentials })
  const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send')
  const res = operation === 'embed' ? await handleEmbeddings(embeddingsRequest({ model: 'house-model', input: 'hi' }, apiKey)) : await runGatewayRequest(transcriptionRequest(apiKey), transcriptionIngress)
  expect(res.status).toBe(501)
  expect((await res.json()).error.code).toBe('unsupported_operation')
  expect(send).not.toHaveBeenCalled()
})
test.each(['embed', 'transcribe'] as const)('mixed %s routes skip Bedrock before an attempt', async (operation) => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'aws', adapter: 'bedrock', priority: 0 }, { name: 'openai', priority: 1 }] })
  const blocked = vi.fn(() => { throw new Error('must not attempt Bedrock') })
  const deps = fakeAdapterByProvider({ aws: { embed: blocked, transcribe: blocked }, openai: { embed: async () => ({ object: 'list', data: [], model: 'up', usage: { prompt_tokens: 1, total_tokens: 1 } }), transcribe: async () => ({ text: 'hello' }) } })
  const res = operation === 'embed' ? await handleEmbeddings(embeddingsRequest({ model: 'house-model', input: 'hi' }, apiKey), deps) : await runGatewayRequest(transcriptionRequest(apiKey), transcriptionIngress, deps)
  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('openai')
  expect(blocked).not.toHaveBeenCalled()
})
