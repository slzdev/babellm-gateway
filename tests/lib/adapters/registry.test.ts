import { beforeEach, expect, test } from 'vitest'
import { createAdapter, resolveApiFlavor, resolveProviderRuntime } from '@/lib/adapters/registry'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { encryptJson } from '@/lib/crypto'
import type { ProviderRow } from '@/lib/db/schema'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'b'.repeat(64)
})

function provider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'p',
    adapter: 'openai',
    baseUrl: null,
    credentials: encryptJson({ apiKey: 'sk-test' }),
    config: '{}',
    apiFlavor: 'chat_completions',
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProviderRow
}

test('resolveProviderRuntime decrypts credentials and parses config', () => {
  const runtime = resolveProviderRuntime(
    provider({ config: '{"disableStreamUsage":true}' }),
  )
  expect(runtime.credentials).toEqual({ apiKey: 'sk-test' })
  expect(runtime.config.disableStreamUsage).toBe(true)
})

test('creates an adapter for the openai type', () => {
  const adapter = createAdapter(provider())
  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.chatStream).toBe('function')
})

test('creates an adapter for the openai_compatible type', () => {
  const adapter = createAdapter(
    provider({
      adapter: 'openai_compatible',
      baseUrl: 'https://api.x.ai/v1',
      credentials: encryptJson({ apiKey: 'xai-test' }),
    }),
  )
  expect(typeof adapter.chat).toBe('function')
})

test('openai_compatible without a base URL is rejected', () => {
  expect(() =>
    createAdapter(provider({ adapter: 'openai_compatible', baseUrl: null })),
  ).toThrow(/base URL/i)
})

test.each(['gemini', 'bedrock'] as const)('%s is not yet implemented', (adapter) => {
  expect(() => createAdapter(provider({ adapter }))).toThrow(UnsupportedOperationError)
})

test('resolveApiFlavor defaults to chat_completions', () => {
  expect(resolveApiFlavor(provider())).toBe('chat_completions')
})

test('resolveApiFlavor reads the stored flavor', () => {
  expect(resolveApiFlavor(provider({ apiFlavor: 'responses' }))).toBe('responses')
})

test('resolveProviderRuntime carries the flavor onto the runtime', () => {
  expect(resolveProviderRuntime(provider({ apiFlavor: 'responses' })).apiFlavor)
    .toBe('responses')
})

test('a responses-flavored provider gets an adapter that speaks responses', () => {
  const adapter = createAdapter(provider({ apiFlavor: 'responses' }))
  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.chatStream).toBe('function')
  expect(typeof adapter.listModels).toBe('function')
})

test('flavor is honoured for openai_compatible providers too', () => {
  const adapter = createAdapter(provider({
    adapter: 'openai_compatible',
    baseUrl: 'https://api.example/v1',
    apiFlavor: 'responses',
  }))
  expect(typeof adapter.chat).toBe('function')
})

test('a responses-flavored openai_compatible provider still needs a base URL', () => {
  expect(() =>
    createAdapter(provider({
      adapter: 'openai_compatible', baseUrl: null, apiFlavor: 'responses',
    })),
  ).toThrow(/base URL/i)
})
