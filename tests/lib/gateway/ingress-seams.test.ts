import { beforeEach, expect, test, vi } from 'vitest'
import { runGatewayRequest, type Ingress } from '@/lib/gateway/handler'
import { postgresStore } from '@/lib/logs/postgres'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { fakeAdapterByProvider, fakeAdapterDeps, seedGateway, seedTargets } from '../../helpers/gateway'
import { waitForLogs } from '../../helpers/logs'
import { resetDb } from '../../helpers/db'

/**
 * Widening `Ingress` (Task 1 of the audio-transcriptions plan) is a pure
 * refactor for Chat and Responses, so it needs a seam of its own to exercise:
 * a minimal fake dialect that proves `runGatewayRequest` drives `read`,
 * `toResponse` and `supports` correctly, independent of what chat.ts or
 * responses.ts happen to do with them.
 */
interface FakeReq {
  model: string
}
type FakeRes = Record<string, unknown>

function makeIngress(overrides: Partial<Ingress<FakeReq, FakeRes, never>> = {}): Ingress<FakeReq, FakeRes, never> {
  return {
    read: async () => ({ model: 'house-model' }),
    modelOf: (req) => req.model,
    isStream: () => false,
    droppedFor: () => [],
    run: async () => ({}),
    finish: (res) => res,
    usageOf: () => null,
    toResponse: (res, headers) => Response.json(res, { headers }),
    ...overrides,
  }
}

function fakeRequest(apiKey: string, headers: Record<string, string> = {}) {
  return new Request('http://gateway.test/v1/fake', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, ...headers },
    body: '{}',
  })
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearRequestLogStoreCache()
  clearPriceCache()
})

test('read receives the real Request, not a pre-parsed body', async () => {
  const { apiKey } = await seedGateway()
  let seenContentType: string | null = null

  const ingress = makeIngress({
    read: async (request) => {
      seenContentType = request.headers.get('content-type')
      return { model: 'house-model' }
    },
    run: async () => ({ ok: true }),
  })

  const response = await runGatewayRequest(
    fakeRequest(apiKey, { 'content-type': 'multipart/form-data; boundary=x' }),
    ingress,
    fakeAdapterDeps({}),
  )

  expect(response.status).toBe(200)
  expect(seenContentType).toBe('multipart/form-data; boundary=x')
})

test('toResponse decides the response, with the attempt headers still merged in', async () => {
  const { apiKey } = await seedGateway()

  const ingress = makeIngress({
    run: async () => ({ ok: true }),
    toResponse: (res, headers) =>
      new Response('hi', { status: 200, headers: { 'content-type': 'text/plain', ...headers } }),
  })

  const response = await runGatewayRequest(fakeRequest(apiKey), ingress, fakeAdapterDeps({}))

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/plain')
  // attemptHeaders came through even though the ingress built its own Response.
  expect(response.headers.get('x-babellm-provider')).toBe('test-provider')
  expect(await response.text()).toBe('hi')
})

test('supports filters the chain: the rejected target is never attempted', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'p1' }, { name: 'p2' }] })
  const p1Chat = vi.fn()
  const p2Chat = vi.fn().mockResolvedValue({ ok: true })

  const ingress = makeIngress({
    supports: (candidate) => candidate.provider.name !== 'p1',
    run: (adapter, ctx, req) => adapter.chat(req as never, ctx) as unknown as Promise<FakeRes>,
  })

  const response = await runGatewayRequest(
    fakeRequest(apiKey),
    ingress,
    fakeAdapterByProvider({ p1: { chat: p1Chat }, p2: { chat: p2Chat } }),
  )

  expect(response.status).toBe(200)
  expect(p1Chat).not.toHaveBeenCalled()
  expect(p2Chat).toHaveBeenCalledTimes(1)
  await waitForLogs()

  const page = await postgresStore.query({ limit: 10 })
  expect(page.rows[0].finalProvider).toBe('p2')
  const detail = await postgresStore.get(page.rows[0].id)
  // One attempt, not two-then-skip: the rejected target was filtered out of
  // the chain, not tried and failed.
  expect(detail?.attempts).toHaveLength(1)
})

// Pins the fix for a real defect: filtering has to feed selectOrder, not
// follow it. selectOrder truncates its ordered chain to model.maxAttempts
// BEFORE anyone can know which candidates this dialect can even use — so
// filtering downstream of that truncation would slice off p1 and p2 (an
// unsupported flavor), see both rejected, and 501 with a perfectly capable
// p3 sitting untried one slot further down. maxAttempts: 2 has to mean "two
// real attempts", not "look at the first two candidates, whatever they are".
test('maxAttempts does not starve a viable target sitting behind unsupported ones', async () => {
  const { apiKey } = await seedTargets({
    maxAttempts: 2,
    targets: [{ name: 'p1' }, { name: 'p2' }, { name: 'p3' }],
  })
  const p3Chat = vi.fn().mockResolvedValue({ ok: true })

  const ingress = makeIngress({
    supports: (candidate) => candidate.provider.name === 'p3',
    run: (adapter, ctx, req) => adapter.chat(req as never, ctx) as unknown as Promise<FakeRes>,
  })

  const response = await runGatewayRequest(
    fakeRequest(apiKey),
    ingress,
    fakeAdapterByProvider({ p1: { chat: vi.fn() }, p2: { chat: vi.fn() }, p3: { chat: p3Chat } }),
  )

  expect(response.status).toBe(200)
  expect(p3Chat).toHaveBeenCalledTimes(1)
})

test('supports rejecting everything answers 501 with no upstream call', async () => {
  const { apiKey } = await seedGateway()
  const chat = vi.fn()

  const ingress = makeIngress({
    supports: () => false,
    run: (adapter, ctx, req) => adapter.chat(req as never, ctx) as unknown as Promise<FakeRes>,
  })

  const response = await runGatewayRequest(fakeRequest(apiKey), ingress, fakeAdapterDeps({ chat }))

  expect(response.status).toBe(501)
  const payload = await response.json()
  expect(payload.error.code).toBe('unsupported_operation')
  expect(chat).not.toHaveBeenCalled()
})

test('an ingress with no newIdentityId still serves a buffered response', async () => {
  const { apiKey } = await seedGateway()

  const ingress = makeIngress({
    run: async () => ({ ok: true }),
    // '' is the documented stand-in for "this dialect mints no id" — proven
    // here by reflecting identity.id back into the body.
    finish: (res, identity) => ({ ...res, identityId: identity.id }),
  })

  const response = await runGatewayRequest(fakeRequest(apiKey), ingress, fakeAdapterDeps({}))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, identityId: '' })
})
