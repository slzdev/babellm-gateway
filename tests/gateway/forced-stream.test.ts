import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { handleResponses } from '@/lib/gateway/responses-handler'
import { resetDb } from '../helpers/db'
import { chatRequest, responsesRequest, seedGateway, seedTargets } from '../helpers/gateway'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const chunk = {
  id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

const completion = {
  id: 'chatcmpl-up', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

const responseBody = {
  id: 'resp-up', object: 'response', created_at: 1, model: 'gpt-4o-mini', status: 'completed',
  output: [{
    type: 'message', id: 'msg-up', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hello', annotations: [] }],
  }],
  usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
}

/** A Responses stream, which terminates in `response.completed` carrying the
 *  whole response — not in chat-completion chunks. */
const responseEvents = [
  { type: 'response.created', response: { ...responseBody, status: 'in_progress', output: [] } },
  { type: 'response.output_text.delta', item_id: 'msg-up', output_index: 0, delta: 'hello' },
  { type: 'response.completed', response: responseBody },
]

function sseResponse(...events: unknown[]): Response {
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(payload, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

/** What the gateway put on the wire for attempt `n` (0-based). */
function sentBody(fetchSpy: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> {
  return JSON.parse(String(fetchSpy.mock.calls[n][1].body))
}

async function force(providerId: string) {
  await db.update(providers)
    .set({ forceUpstreamStream: true })
    .where(eq(providers.id, providerId))
}

/** Forced *and* Responses-native, so the Responses ingress reaches
 *  withForcedResponseStream rather than crossing into chat shape first. */
async function forceResponsesNative(providerId: string) {
  await db.update(providers)
    .set({ forceUpstreamStream: true, apiFlavor: 'responses' })
    .where(eq(providers.id, providerId))
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// These tests deliberately go through the REAL createAdapter rather than
// fakeAdapterDeps, stubbing global fetch instead: the behaviour under test is
// the composition in registry.ts, and a fake adapter would stub out precisely
// the thing that has to be proved.

test('a stream:false client against a forced target gets one body while the upstream streamed', async () => {
  const { apiKey, provider } = await seedGateway()
  await force(provider.id)
  const fetchSpy = vi.fn().mockResolvedValue(sseResponse(chunk))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleChatCompletions(chatRequest({ ...body, stream: false }, apiKey))

  expect(sentBody(fetchSpy).stream).toBe(true)
  expect(response.headers.get('content-type')).toMatch(/application\/json/)
  const parsed = await response.json()
  expect(parsed.object).toBe('chat.completion')
  expect(parsed.choices[0].message.content).toBe('hello')
  expect(parsed.model).toBe('house-model')
})

test('the same holds through the Responses ingress on a Responses-native target', async () => {
  // The Chat ingress and the Responses ingress reach forcing through
  // different wrappers — withForcedChatStream inside withRespondViaChat for
  // the first, withForcedResponseStream for the second. Half the feature's
  // scope lives on this path and nothing else drives it end to end.
  const { apiKey, provider } = await seedGateway()
  await forceResponsesNative(provider.id)
  const fetchSpy = vi.fn().mockResolvedValue(sseResponse(...responseEvents))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', stream: false }, apiKey),
  )

  expect(sentBody(fetchSpy).stream).toBe(true)
  expect(response.headers.get('content-type')).toMatch(/application\/json/)
  const parsed = await response.json()
  expect(parsed.object).toBe('response')
  expect(parsed.status).toBe('completed')
  expect(parsed.output[0].content[0].text).toBe('hello')
  expect(parsed.model).toBe('house-model')
})

test('the same request against an unforced target calls the non-streaming upstream', async () => {
  const { apiKey } = await seedGateway()
  const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(completion))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleChatCompletions(chatRequest({ ...body, stream: false }, apiKey))

  expect(sentBody(fetchSpy).stream).toBe(false)
  expect((await response.json()).object).toBe('chat.completion')
})

test('a client that asked for a stream is unaffected by forcing', async () => {
  const { apiKey, provider } = await seedGateway()
  await force(provider.id)
  const fetchSpy = vi.fn().mockResolvedValue(sseResponse(chunk))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleChatCompletions(chatRequest({ ...body, stream: true }, apiKey))

  expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
  expect(await response.text()).toContain('data: [DONE]')
})

test('a forced upstream that produces nothing fails over to the next target', async () => {
  // The regression guard for the wrapper ever being moved outside execute():
  // draining inside chat() is what makes a mid-response upstream failure
  // pre-commit and therefore recoverable.
  //
  // TWO targets, not one. selectOrder() ends with
  // `ordered.slice(0, maxAttempts)` — it caps the chain, it never repeats a
  // candidate — so a single seeded target gets exactly one attempt and cannot
  // demonstrate failover at all.
  const { apiKey, targets } = await seedTargets({
    targets: [{ name: 'forced' }, { name: 'plain' }],
  })
  await force(targets[0].provider.id)

  const fetchSpy = vi.fn()
    // Attempt 1, the forced target: an upstream that opened a stream and then
    // said nothing. collapseChatStream throws, execute() classifies it
    // retryable and moves to the next target.
    .mockResolvedValueOnce(new Response('data: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }))
    // Attempt 2, the unforced target: an ordinary non-streaming answer.
    .mockResolvedValueOnce(jsonResponse(completion))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleChatCompletions(chatRequest({ ...body, stream: false }, apiKey))

  expect(response.status).toBe(200)
  expect(response.headers.get('x-babellm-provider')).toBe('plain')
  expect((await response.json()).choices[0].message.content).toBe('hello')
  // The first attempt asked for a stream, the second did not — which is the
  // per-provider setting being applied per candidate rather than per request.
  expect(sentBody(fetchSpy, 0).stream).toBe(true)
  expect(sentBody(fetchSpy, 1).stream).toBe(false)
})
