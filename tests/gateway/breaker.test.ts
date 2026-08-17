import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { getHealthStore, resetHealthStore } from '@/lib/health'
import { clearRoutingSettingsCache } from '@/lib/routing-settings'
import { setRoutingSettings } from '@/lib/settings'
import { chatRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

function completion(from: string) {
  return {
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    created: 1,
    model: `${from}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content: from }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

const apiError = (status: number, message = 'boom') =>
  new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  await resetDb()
  resetHealthStore()
  clearRoutingSettingsCache()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  resetHealthStore()
  clearRoutingSettingsCache()
})

test('a target that keeps failing stops being attempted', async () => {
  await setRoutingSettings({ threshold: 2, cooldownSeconds: 30 })
  clearRoutingSettingsCache()
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const primary = vi.fn().mockRejectedValue(apiError(503, 'down'))
  const backup = vi.fn().mockResolvedValue(completion('backup'))
  const deps = fakeAdapterByProvider({
    primary: { chat: primary },
    backup: { chat: backup },
  })

  // Two failures open the breaker. Both requests still succeed via failover.
  for (let i = 0; i < 2; i += 1) {
    expect((await handleChatCompletions(chatRequest(body, apiKey), deps)).status).toBe(200)
  }
  expect(primary).toHaveBeenCalledTimes(2)

  // recordHealth is fire-and-forget, so let the queued writes settle before
  // asserting on what the next request sees.
  await new Promise((resolve) => setImmediate(resolve))

  for (let i = 0; i < 2; i += 1) {
    expect((await handleChatCompletions(chatRequest(body, apiKey), deps)).status).toBe(200)
  }

  // The whole point of the feature: the broken target is not called again.
  expect(primary).toHaveBeenCalledTimes(2)
  expect(backup).toHaveBeenCalledTimes(4)
})

test('a request is still attempted when every target has an open breaker', async () => {
  await setRoutingSettings({ threshold: 1, cooldownSeconds: 30 })
  clearRoutingSettingsCache()
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const failing = fakeAdapterByProvider({
    primary: { chat: vi.fn().mockRejectedValue(apiError(503)) },
    backup: { chat: vi.fn().mockRejectedValue(apiError(503)) },
  })
  await handleChatCompletions(chatRequest(body, apiKey), failing)
  await new Promise((resolve) => setImmediate(resolve))

  // Both breakers are open and the providers have recovered. Demotion rather
  // than exclusion means the request is still attempted, and still succeeds.
  const recovered = fakeAdapterByProvider({
    primary: { chat: vi.fn().mockResolvedValue(completion('primary')) },
    backup: { chat: vi.fn().mockResolvedValue(completion('backup')) },
  })
  expect((await handleChatCompletions(chatRequest(body, apiKey), recovered)).status).toBe(200)
})

test('routing is unchanged when the health store is unusable', async () => {
  // Fail-open is the contract: a Redis outage degrades routing to its
  // pre-breaker behaviour, never to something worse.
  await setRoutingSettings({ threshold: 1, cooldownSeconds: 30 })
  clearRoutingSettingsCache()
  const { apiKey } = await seedTargets({
    targets: [{ name: 'primary', priority: 0 }, { name: 'backup', priority: 1 }],
  })

  const store = getHealthStore()
  const boom = () => Promise.reject(new Error('redis is gone'))
  store.openTargets = boom
  store.fail = boom
  store.succeed = boom
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const primary = vi.fn().mockRejectedValue(apiError(503, 'down'))
  const deps = fakeAdapterByProvider({
    primary: { chat: primary },
    backup: { chat: vi.fn().mockResolvedValue(completion('backup')) },
  })

  for (let i = 0; i < 3; i += 1) {
    expect((await handleChatCompletions(chatRequest(body, apiKey), deps)).status).toBe(200)
    await new Promise((resolve) => setImmediate(resolve))
  }

  // Never skipped, never crashed — exactly what happened before the breaker.
  expect(primary).toHaveBeenCalledTimes(3)
})
