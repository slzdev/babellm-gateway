import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleResponses } from '@/lib/gateway/responses-handler'
import {
  responsesRequest, fakeAdapterByProvider, seedGateway, seedTargets,
} from '../helpers/gateway'
import { resetDb } from '../helpers/db'

function response(id: string) {
  return {
    id, object: 'response', created_at: 1, model: 'up-model', status: 'completed',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi', annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

test('serves a Responses request from a Responses-native target', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    fakeAdapterByProvider({ p1: { respond: vi.fn().mockResolvedValue(response('resp_upstream')) } }),
  )

  expect(res.status).toBe(200)
  const body = await res.json()
  // The provider's id survives, because the client sends it back as
  // previous_response_id; the model becomes the virtual name.
  expect(body.id).toBe('resp_upstream')
  expect(body.model).toBe('house-model')
  expect(res.headers.get('x-babellm-provider')).toBe('p1')
})

test('rejects a request with no credentials', async () => {
  await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  const res = await handleResponses(responsesRequest({ model: 'house-model', input: 'hi' }, null), fakeAdapterByProvider({}))

  expect(res.status).toBe(401)
})

test('rejects background at parse time, before any target is tried', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })
  const respond = vi.fn()

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', background: true }, apiKey),
    fakeAdapterByProvider({ p1: { respond } }),
  )

  expect(res.status).toBe(400)
  expect(respond).not.toHaveBeenCalled()
})

test('fails over to a second Responses target', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'p1', apiFlavor: 'responses' }, { name: 'p2', apiFlavor: 'responses' }],
  })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    fakeAdapterByProvider({
      p1: { respond: vi.fn().mockRejectedValue(new OpenAI.APIError(429, { message: 'slow' }, 'slow', undefined)) },
      p2: { respond: vi.fn().mockResolvedValue(response('resp_two')) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('p2')
})

test('answers 501 when the provider adapter itself is not implemented', async () => {
  // Since Task 14, every adapter respond()/respondStream() is required and a
  // chat-only target serves a Responses request through withRespondViaChat —
  // see mixed-flavor.test.ts. The only remaining "cannot serve" case is an
  // adapter type the registry has no constructor for at all. Exercised with
  // the real registry (no deps override), matching the equivalent bedrock
  // regression test in chat.test.ts.
  const { apiKey } = await seedGateway({
    adapter: 'bedrock',
    credentials: { region: 'us-east-1', useInstanceRole: true },
  })

  const res = await handleResponses(responsesRequest({ model: 'house-model', input: 'hi' }, apiKey))
  const json = await res.json()

  expect(res.status).toBe(501)
  expect(json.error.code).toBe('unsupported_operation')
})

test('streams named events and never sends [DONE]', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1', apiFlavor: 'responses' }] })

  // The upstream SDK's stream event union requires a fully-populated Response
  // object on every response-carrying event; a partial fixture is cast rather
  // than filled in, matching the pattern the chat stream tests already use.
  async function* respondStream() {
    yield { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', model: 'up', output: [] } }
    yield { type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' }
    yield { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', model: 'up', output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
  }

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi', stream: true }, apiKey),
    fakeAdapterByProvider({ p1: { respondStream: respondStream as never } }),
  )

  const body = await res.text()
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  expect(body).toContain('event: response.created')
  expect(body).toContain('event: response.output_text.delta')
  expect(body).toContain('event: response.completed')
  expect(body).not.toContain('[DONE]')
})

test('retrieval says why it is unsupported rather than 404ing blankly', async () => {
  const { GET } = await import('@/app/v1/responses/[id]/route')

  const res = await GET()
  expect(res.status).toBe(404)
  expect((await res.json()).error.code).toBe('unsupported_endpoint')
})
