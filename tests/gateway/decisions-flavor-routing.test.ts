import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { handleResponses } from '@/lib/gateway/responses-handler'
import { resetHealthStore } from '@/lib/health'
import { clearPriceCache } from '@/lib/pricing'
import { chatRequest, responsesRequest, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'
import { waitForLogs } from '../helpers/logs'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
  clearPriceCache()
  resetHealthStore()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => { await waitForLogs(); vi.restoreAllMocks(); resetHealthStore() })

const completion = {
  id: 'upstream_1', object: 'chat.completion', created: 1, model: 'chat-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Chat answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
}
const chunk = { id: 'upstream_1', object: 'chat.completion.chunk', created: 1, model: 'chat-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Chat answer' }, finish_reason: null }] }
const ingresses = [
  { name: 'chat', handle: handleChatCompletions, request: chatRequest, body: { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] } },
  { name: 'Responses', handle: handleResponses, request: responsesRequest, body: { model: 'house-model', input: 'hi' } },
] as const

for (const ingress of ingresses) {
  test.each([false, true])(`${ingress.name} skips Decisions before maxAttempts (stream=%s)`, async (stream) => {
    const { apiKey } = await seedTargets({ maxAttempts: 1, targets: [
      { name: 'decisions', apiFlavor: 'decisions', priority: 0 },
      { name: 'chat', priority: 1 },
    ] })
    let sentUrl: string | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      sentUrl = String(url)
      return stream
        ? new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        : Response.json(completion)
    })
    const res = await ingress.handle(ingress.request({ ...ingress.body, stream }, apiKey))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-babellm-provider')).toBe('chat')
    expect(sentUrl).toBe('https://api.openai.com/v1/chat/completions')
    const result = await res.text()
    expect(result).toContain('Chat answer')
    if (stream) expect(result).toContain(ingress.name === 'chat' ? '[DONE]' : 'response.completed')
  })

  test.each([false, true])(`${ingress.name} refuses a Decisions-only chain without fetch (stream=%s)`, async (stream) => {
    const { apiKey } = await seedTargets({ targets: [{ name: 'decisions', apiFlavor: 'decisions' }] })
    const transport = vi.spyOn(globalThis, 'fetch')
    const res = await ingress.handle(ingress.request({ ...ingress.body, stream }, apiKey))
    expect(res.status).toBe(501)
    expect((await res.json()).error.message).toContain('Decisions')
    expect(transport).not.toHaveBeenCalled()
  })

  test(`${ingress.name} preserves Gemini adapter-first routing with a Decisions model label`, async () => {
    const { apiKey } = await seedTargets({ targets: [{ name: 'gem', adapter: 'gemini', apiFlavor: 'decisions' }] })
    let sentUrl: string | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      sentUrl = String(url)
      return Response.json({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Gemini answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } })
    })
    const res = await ingress.handle(ingress.request(ingress.body, apiKey))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Gemini answer')
    expect(sentUrl).toContain('generateContent')
  })
}

test('a Decisions-flavored OpenAI model retains native embeddings and transcription ingress', async () => {
  const { handleEmbeddings } = await import('@/lib/gateway/embeddings-handler')
  const { handleTranscriptions } = await import('@/lib/gateway/transcriptions-handler')
  const { embeddingsRequest } = await import('../helpers/gateway')
  const { apiKey } = await seedTargets({ targets: [{ name: 'decisions', apiFlavor: 'decisions' }] })
  const embedding = { object: 'list', model: 'decisions-model', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1, total_tokens: 1 } }
  const sentUrls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    sentUrls.push(String(url))
    return Response.json(String(url).endsWith('/embeddings') ? embedding : { text: 'Audio answer' })
  })
  const embedded = await handleEmbeddings(embeddingsRequest({ model: 'house-model', input: 'hi' }, apiKey))
  expect(embedded.status).toBe(200)
  expect((await embedded.json()).data[0].embedding).toEqual([0.1, 0.2])
  const form = new FormData()
  form.set('model', 'house-model')
  form.set('file', new File(['audio'], 'clip.mp3', { type: 'audio/mpeg' }))
  const transcribed = await handleTranscriptions(new Request('http://gateway.test/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form }))
  expect(transcribed.status).toBe(200)
  expect(await transcribed.json()).toEqual({ text: 'Audio answer' })
  expect(sentUrls).toContain('https://api.openai.com/v1/embeddings')
  expect(sentUrls).toContain('https://api.openai.com/v1/audio/transcriptions')
})
