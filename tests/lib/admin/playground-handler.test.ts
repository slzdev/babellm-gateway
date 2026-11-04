import { afterEach, beforeEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import type { ChatCompletion, ChatCompletionChunk, ProviderAdapter } from '@/lib/adapters/types'
import { handlePlaygroundChat, type PlaygroundHandlerDeps } from '@/lib/admin/playground-handler'
import { signSession } from '@/lib/admin/session'
import { db } from '@/lib/db'
import { apiKeys, requestLogs } from '@/lib/db/schema'
import { generateApiKey } from '@/lib/gateway/auth'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { clearRequestLogStoreCache } from '@/lib/logs/registry'
import { clearPriceCache } from '@/lib/pricing'
import { setLoggingSettings } from '@/lib/settings'
import { getUsageStore, readUsage, resetUsageStore } from '@/lib/usage'
import { totalSpendKey } from '@/lib/usage/keys'
import { resetDb } from '../../helpers/db'
import { chatRequest, fakeAdapterDeps, seedGateway, seedPrices } from '../../helpers/gateway'
import { waitFor } from '../../helpers/logs'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }
const completion: ChatCompletion = {
  id: 'upstream', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello', refusal: null }, finish_reason: 'stop', logprobs: null }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}
const chunk: ChatCompletionChunk = {
  id: 'upstream', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
}
let logIds: string[]

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  delete process.env.REDIS_URL
  await resetDb()
  await setLoggingSettings({ store: 'postgres' })
  clearRequestLogStoreCache()
  clearPriceCache()
  resetUsageStore()
  logIds = []
})

afterEach(async () => {
  // Drain actual asynchronous writes before the next test truncates tables.
  for (const id of logIds) await rowFor(id)
})

function deps(adapter: Partial<ProviderAdapter> = {}): PlaygroundHandlerDeps {
  return {
    isAuthenticated: async () => true,
    ...fakeAdapterDeps({ async chat() { return completion }, ...adapter }),
  }
}

function request(payload: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('http://gateway.test/playground/chat', {
    method: 'POST', headers: { origin: 'http://gateway.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload), signal,
  })
}

function track(response: Response) {
  const id = response.headers.get('x-request-id')
  if (id && response.status !== 429) logIds.push(id)
  return response
}

async function run(req: Request, dependencies = deps()) {
  return track(await handlePlaygroundChat(req, dependencies))
}

async function rowFor(id: string) {
  await waitFor(async () => (await db.select().from(requestLogs).where(eq(requestLogs.id, id))).length === 1)
  return (await db.select().from(requestLogs).where(eq(requestLogs.id, id)))[0]
}

async function otherKey(overrides: Partial<typeof apiKeys.$inferInsert> = {}) {
  const generated = generateApiKey()
  const [row] = await db.insert(apiKeys).values({
    name: 'Selected key', keyHash: generated.keyHash, keyPrefix: generated.keyPrefix, ...overrides,
  }).returning()
  return row
}

test('anonymous requests return JSON 401 before reading even a malformed body', async () => {
  const req = new Request('http://gateway.test/playground/chat', { method: 'POST', body: '{bad' })
  const response = await run(req, { ...deps(), isAuthenticated: async () => false })
  expect(response.status).toBe(401)
  expect((await response.json()).error.type).toBe('invalid_request_error')
  expect(req.bodyUsed).toBe(false)
  expect(await db.select().from(requestLogs)).toEqual([])
})

test.each([
  ['missing', undefined, undefined],
  ['malformed', 'not an origin', undefined],
  ['opaque', 'null', undefined],
  ['other host', 'http://evil.test', undefined],
  ['other port', 'http://gateway.test:3001', undefined],
  ['non-http', 'ftp://gateway.test', undefined],
  ['path', 'http://gateway.test/path', undefined],
  ['trailing slash', 'http://gateway.test/', undefined],
  ['credentials', 'http://user:password@gateway.test', undefined],
  ['query', 'http://gateway.test?x=1', undefined],
  ['fragment', 'http://gateway.test#fragment', undefined],
  ['cross-site metadata', 'http://gateway.test', 'cross-site'],
  ['same-site metadata', 'http://gateway.test', 'same-site'],
  ['navigation metadata', 'http://gateway.test', 'none'],
])('rejects %s Origin access before reading a body', async (_name, origin, fetchSite) => {
  const headers = new Headers()
  if (origin !== undefined) headers.set('origin', origin)
  if (fetchSite !== undefined) headers.set('sec-fetch-site', fetchSite)
  const req = new Request('http://gateway.test/playground/chat', { method: 'POST', headers, body: '{bad' })
  const response = await run(req)
  expect(response.status).toBe(403)
  expect((await response.json()).error.type).toBe('invalid_request_error')
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
  expect(req.bodyUsed).toBe(false)
  expect(await db.select().from(requestLogs)).toEqual([])
})

test.each([
  { origin: 'http://gateway.test' },
  { origin: 'http://gateway.test', 'sec-fetch-site': 'same-origin' },
  { origin: 'https://public.test:8443', host: 'internal.test', 'x-forwarded-host': 'public.test:8443, proxy.test' },
  { origin: 'https://host.test', host: 'host.test' },
] as Record<string, string>[])('accepts the effective same-origin host $origin', async (headers) => {
  const { key } = await seedGateway()
  const response = await run(request({ ...body, apiKeyId: key.id }, headers))
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe('hello')
})

test('forwarded host takes precedence over Host and request URL', async () => {
  const response = await run(request(body, { 'x-forwarded-host': 'external.test', host: 'gateway.test' }))
  expect(response.status).toBe(403)
})

test('invalid JSON is returned in the existing 400 envelope', async () => {
  const response = await run(new Request('http://gateway.test/playground/chat', {
    method: 'POST', headers: { origin: 'http://gateway.test' }, body: '{bad',
  }))
  expect(response.status).toBe(400)
  expect((await response.json()).error.code).toBe('invalid_json')
})

test.each([undefined, null, '', 'secret-value', 42, {}, '00000000-0000-0000-0000-invalidvalue'])('rejects malformed key ID %j with 400', async (apiKeyId) => {
  const response = await run(request({ ...body, apiKeyId }))
  expect(response.status).toBe(400)
  const json = await response.json()
  expect(json.error.param).toBe('apiKeyId')
  expect(JSON.stringify(json)).not.toContain('secret-value')
})

test.each(['missing', 'deleted', 'disabled', 'expired'] as const)('rejects a %s selected key with 401', async (state) => {
  let id = '00000000-0000-4000-8000-000000000001'
  if (state !== 'missing') {
    const row = await otherKey({ enabled: state !== 'disabled', expiresAt: state === 'expired' ? new Date(Date.now() - 1) : null })
    id = row.id
    if (state === 'deleted') await db.delete(apiKeys).where(eq(apiKeys.id, id))
  }
  const response = await run(request({ ...body, apiKeyId: id }))
  expect(response.status).toBe(401)
  const json = await response.json()
  expect(json.error.code).toBe(state === 'disabled' ? 'key_disabled' : state === 'expired' ? 'key_expired' : 'invalid_api_key')
  expect(JSON.stringify(json)).not.toContain(id)
})

test('revalidates a selected key disabled after a successful request', async () => {
  const { key } = await seedGateway()
  expect((await run(request({ ...body, apiKeyId: key.id }))).status).toBe(200)
  await rowFor(logIds[0])
  await db.update(apiKeys).set({ enabled: false }).where(eq(apiKeys.id, key.id))
  const response = await run(request({ ...body, apiKeyId: key.id }))
  expect(response.status).toBe(401)
  expect((await response.json()).error.code).toBe('key_disabled')
})

test('selected key owns JSON metadata, logs, payload capture, usage, and last-used despite a different Bearer key', async () => {
  const { key: bearer, apiKey, provider } = await seedGateway({ limits: { tpmLimit: 100, budgetTotalUsd: '1' } })
  const selected = await otherKey({ logPayloads: true, tpmLimit: 100, budgetTotalUsd: '1' })
  await seedPrices(provider.id, 'gpt-4o-mini', { inputPerMtok: '1', outputPerMtok: '3' })
  const response = await run(request({ ...body, apiKeyId: selected.id }, {
    authorization: `Bearer ${apiKey}`, 'x-babellm-tags': 'source=forged,other=untrusted',
  }), deps({
    async chat(payload) {
      // This boundary must never receive an admin selection field.
      if ('apiKeyId' in payload) throw new Error('Selection field leaked upstream')
      return completion
    },
  }))
  expect(response.status).toBe(200)
  expect(response.headers.get('x-babellm-provider')).toBe('test-provider')
  expect(response.headers.get('x-babellm-upstream-model')).toBe('gpt-4o-mini')
  const json = await response.json()
  expect(json.model).toBe('house-model')
  expect(json.usage.cost.total).toBe('0.000011000')
  const log = await rowFor(response.headers.get('x-request-id')!)
  expect(log).toMatchObject({ apiKeyId: selected.id, keyName: 'Selected key', promptTokens: 5, completionTokens: 2, costUsd: '0.000011000', payloadCaptured: true, tags: { source: 'playground' } })
  expect(log.requestJson).toMatchObject(body)
  expect(log.requestJson).not.toHaveProperty('apiKeyId')
  expect(JSON.stringify(log.requestJson)).not.toContain(apiKey)
  expect(log.responseJson).toMatchObject({ choices: [{ message: { content: 'hello' } }] })
  await waitFor(async () => (await readUsage([selected])).get(selected.id)?.tpm === 7)
  expect((await readUsage([selected])).get(selected.id)?.totalUsd).toBeCloseTo(0.000011, 9)
  expect((await readUsage([bearer])).get(bearer.id)).toMatchObject({ tpm: 0, totalUsd: 0 })
  await waitFor(async () => (await db.select().from(apiKeys).where(eq(apiKeys.id, selected.id)))[0].lastUsedAt !== null)
  expect((await db.select().from(apiKeys).where(eq(apiKeys.id, bearer.id)))[0].lastUsedAt).toBeNull()
})

test('payload capture stays off for the selected key even if the Bearer key captures payloads', async () => {
  const { key: bearer, apiKey } = await seedGateway()
  await db.update(apiKeys).set({ logPayloads: true }).where(eq(apiKeys.id, bearer.id))
  const selected = await otherKey()
  const response = await run(request({ ...body, apiKeyId: selected.id }, { authorization: `Bearer ${apiKey}` }))
  expect(response.status).toBe(200)
  expect(await rowFor(response.headers.get('x-request-id')!)).toMatchObject({ apiKeyId: selected.id, payloadCaptured: false, requestJson: null, responseJson: null })
})

test('selected-key rate limits reject another request before upstream execution', async () => {
  await seedGateway()
  const selected = await otherKey({ rpmLimit: 1 })
  expect((await run(request({ ...body, apiKeyId: selected.id }))).status).toBe(200)
  const response = await run(request({ ...body, apiKeyId: selected.id }), deps({ async chat() { throw new Error('A rate-limited request reached upstream') } }))
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBeTruthy()
  expect((await response.json()).error.code).toBe('rate_limit_exceeded')
})

test('selected-key budget rejection applies even with an unlimited Bearer key', async () => {
  const { apiKey } = await seedGateway()
  const selected = await otherKey({ budgetTotalUsd: '1' })
  await getUsageStore().apply([{ key: totalSpendKey(selected.id), kind: 'float', by: 1 }])
  const response = await run(request({ ...body, apiKeyId: selected.id }, { authorization: `Bearer ${apiKey}` }))
  expect(response.status).toBe(429)
  expect((await response.json()).error.code).toBe('insufficient_quota')
})

test('SSE arrives incrementally and keeps metadata and selected-key accounting', async () => {
  await seedGateway()
  const selected = await otherKey({ logPayloads: true, tpmLimit: 100 })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const response = await run(request({ ...body, apiKeyId: selected.id, stream: true }), deps({
    async *chatStream() {
      yield chunk
      await gate
      yield { ...chunk, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
    },
  }))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  expect(response.headers.get('x-babellm-provider')).toBe('test-provider')
  expect(response.headers.get('x-babellm-upstream-model')).toBe('gpt-4o-mini')
  expect(response.headers.get('x-ratelimit-limit-tokens')).toBe('100')
  const reader = response.body!.getReader()
  try {
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    expect(text).toContain('hello')
    expect(text).toContain('house-model')
    expect(text).not.toContain('[DONE]')
  } finally {
    release()
  }
  let rest = ''
  for (;;) {
    const value = await reader.read()
    if (value.done) break
    rest += new TextDecoder().decode(value.value)
  }
  expect(rest).toContain('[DONE]')
  expect(rest).toContain('"total_tokens":7')
  const log = await rowFor(response.headers.get('x-request-id')!)
  expect(log).toMatchObject({ apiKeyId: selected.id, stream: true, outcome: 'ok', promptTokens: 5, completionTokens: 2, tags: { source: 'playground' }, payloadCaptured: true })
  expect(log.responseJson).toMatchObject({ choices: [{ message: { content: 'hello' } }] })
  await waitFor(async () => (await readUsage([selected])).get(selected.id)?.tpm === 7)
})

test('aborting the inbound request reaches the adapter signal and records client_closed', async () => {
  const { key } = await seedGateway()
  const controller = new AbortController()
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  let upstreamAborted = false
  const pending = run(request({ ...body, apiKeyId: key.id }, {}, controller.signal), deps({
    async chat(_payload, ctx) {
      const aborted = new Promise<never>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          upstreamAborted = true
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
      started()
      return aborted
    },
  }))
  await ready
  controller.abort()
  const response = await pending
  expect(upstreamAborted).toBe(true)
  expect(response.status).toBe(504)
  expect(await rowFor(response.headers.get('x-request-id')!)).toMatchObject({ apiKeyId: key.id, outcome: 'client_closed' })
})

test.each(['cookie only', 'ID as Bearer', 'session authorization'])('public endpoint refuses key-ID/session authentication (%s)', async (mode) => {
  const { key } = await seedGateway()
  const session = signSession(Date.now() + 60_000)
  const authorization = mode === 'ID as Bearer' ? `Bearer ${key.id}`
    : mode === 'session authorization' ? `Session ${session}` : null
  const response = track(await handleChatCompletions(chatRequest({ ...body, apiKeyId: key.id }, null, {
    cookie: `babellm_session=${session}`, ...(authorization ? { authorization } : {}),
  }), fakeAdapterDeps({})))
  expect(response.status).toBe(401)
})
