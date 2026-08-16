import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PATHS,
  PATH_FIELDS,
  mergeProviderPaths,
  parseProviderPath,
  resolveProviderPaths,
} from '@/lib/adapters/openai/paths'

describe('parseProviderPath', () => {
  test('reads a blank value as "use the default"', () => {
    expect(parseProviderPath('')).toBeNull()
    expect(parseProviderPath('   ')).toBeNull()
  })

  test('keeps a well-formed path as written', () => {
    expect(parseProviderPath('/v1/chat/completions')).toBe('/v1/chat/completions')
  })

  test('adds the leading slash a hand-typed path usually omits', () => {
    expect(parseProviderPath('api/v2/models')).toBe('/api/v2/models')
  })

  test('drops surrounding whitespace and a trailing slash', () => {
    expect(parseProviderPath('  /openai/v1/chat/  ')).toBe('/openai/v1/chat')
  })

  test('collapses a repeated leading slash rather than building a protocol-relative URL', () => {
    expect(parseProviderPath('//models')).toBe('/models')
  })

  test('rejects an absolute URL, because paths are joined onto the base URL', () => {
    expect(() => parseProviderPath('https://api.x.ai/v1/models')).toThrow(/base URL/i)
  })

  test('rejects a query string, which the SDK sends separately', () => {
    expect(() => parseProviderPath('/models?limit=100')).toThrow(/query/i)
  })

  test('rejects a value that normalises away to nothing', () => {
    expect(() => parseProviderPath('/')).toThrow(/not a valid path/i)
  })
})

describe('resolveProviderPaths', () => {
  test('falls back to the SDK defaults when the config sets nothing', () => {
    expect(resolveProviderPaths({})).toEqual({
      models: '/models',
      chatCompletions: '/chat/completions',
    })
    expect(DEFAULT_PATHS).toEqual({
      models: '/models',
      chatCompletions: '/chat/completions',
    })
  })

  test('overrides only the endpoint the config names', () => {
    expect(resolveProviderPaths({ chatCompletionsPath: '/api/v2/chat' })).toEqual({
      models: '/models',
      chatCompletions: '/api/v2/chat',
    })
  })

  test('reads both overrides together', () => {
    expect(resolveProviderPaths({
      modelsPath: '/api/models',
      chatCompletionsPath: '/api/chat',
    })).toEqual({
      models: '/api/models',
      chatCompletions: '/api/chat',
    })
  })

  test('normalises a stored value written before validation existed', () => {
    expect(resolveProviderPaths({ modelsPath: 'api/models/' }).models).toBe('/api/models')
  })

  test('ignores a non-string or unusable stored value instead of building a broken URL', () => {
    expect(resolveProviderPaths({ modelsPath: 42 as never }).models).toBe('/models')
    expect(resolveProviderPaths({ chatCompletionsPath: '' }).chatCompletions)
      .toBe('/chat/completions')
    expect(resolveProviderPaths({ chatCompletionsPath: 'https://x/y' }).chatCompletions)
      .toBe('/chat/completions')
  })
})

describe('PATH_FIELDS', () => {
  test('describes each endpoint once, keyed by the config key it writes', () => {
    expect(PATH_FIELDS.map((f) => f.name)).toEqual(['modelsPath', 'chatCompletionsPath'])
  })

  test('carries the default as the placeholder, so a blank box reads as "default"', () => {
    expect(PATH_FIELDS.map((f) => f.placeholder)).toEqual(['/models', '/chat/completions'])
  })
})

describe('mergeProviderPaths', () => {
  test('writes a submitted path onto the stored config', () => {
    expect(mergeProviderPaths({}, { modelsPath: '/api/models' }))
      .toEqual({ modelsPath: '/api/models' })
  })

  test('normalises on the way in, so the stored value is already canonical', () => {
    expect(mergeProviderPaths({}, { chatCompletionsPath: 'api/chat/' }))
      .toEqual({ chatCompletionsPath: '/api/chat' })
  })

  test('a submitted blank clears the override rather than storing an empty path', () => {
    expect(mergeProviderPaths({ modelsPath: '/api/models' }, { modelsPath: '  ' }))
      .toEqual({})
  })

  test('an absent field leaves the stored override alone', () => {
    // The fields are only rendered for OpenAI-shaped adapters, so "not
    // submitted" has to mean "not applicable" rather than "cleared".
    expect(mergeProviderPaths({ modelsPath: '/api/models' }, {}))
      .toEqual({ modelsPath: '/api/models' })
  })

  test('leaves config keys no form exposes untouched', () => {
    expect(mergeProviderPaths(
      { timeoutMs: 5000, registryNamespace: 'xai' },
      { chatCompletionsPath: '/api/chat' },
    )).toEqual({ timeoutMs: 5000, registryNamespace: 'xai', chatCompletionsPath: '/api/chat' })
  })

  test('does not mutate the config it was handed', () => {
    const config = { modelsPath: '/api/models' }
    mergeProviderPaths(config, { modelsPath: '' })
    expect(config).toEqual({ modelsPath: '/api/models' })
  })

  test('rejects an invalid submission instead of storing it', () => {
    expect(() => mergeProviderPaths({}, { modelsPath: 'https://api.x.ai/v1/models' }))
      .toThrow(/base URL/i)
  })
})
