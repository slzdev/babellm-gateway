import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PATHS,
  MODEL_PATH_FIELDS,
  PATH_FIELDS,
  mergeProviderPaths,
  parseProviderPath,
  resolveProviderPaths,
  resolveRequestPaths,
} from '@/lib/adapters/paths'

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
    expect(parseProviderPath('  /openai/v1/responses/  ')).toBe('/openai/v1/responses')
  })

  test('collapses a repeated leading slash rather than building a protocol-relative URL', () => {
    expect(parseProviderPath('//models')).toBe('/models')
  })

  test('rejects a full URL, because the host is the base URL\'s to name', () => {
    expect(() => parseProviderPath('https://api.x.ai/v1/models')).toThrow(/full URL/i)
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
      responses: '/responses',
      messages: '/messages',
    })
    expect(DEFAULT_PATHS).toEqual({
      models: '/models',
      chatCompletions: '/chat/completions',
      responses: '/responses',
      messages: '/messages',
    })
  })

  test('overrides only the endpoint the config names', () => {
    expect(resolveProviderPaths({ chatCompletionsPath: '/api/v2/chat' })).toEqual({
      models: '/models',
      chatCompletions: '/api/v2/chat',
      responses: '/responses',
      messages: '/messages',
    })
  })

  test('reads all three overrides together', () => {
    expect(resolveProviderPaths({
      modelsPath: '/api/models',
      chatCompletionsPath: '/api/chat',
      responsesPath: '/api/responses',
    })).toEqual({
      models: '/api/models',
      chatCompletions: '/api/chat',
      responses: '/api/responses',
      messages: '/messages',
    })
  })

  test('normalises a stored value written before validation existed', () => {
    expect(resolveProviderPaths({ modelsPath: 'api/models/' }).models).toBe('/api/models')
  })

  test('ignores a non-string or unusable stored value instead of building a broken URL', () => {
    expect(resolveProviderPaths({ modelsPath: 42 as never }).models).toBe('/models')
    expect(resolveProviderPaths({ responsesPath: '' }).responses).toBe('/responses')
    expect(resolveProviderPaths({ responsesPath: 'https://x/y' }).responses).toBe('/responses')
  })
})

describe('resolveRequestPaths', () => {
  const base = 'https://example.com/gwt/v1'

  test('leaves an unconfigured endpoint relative, so the base URL keeps its prefix', () => {
    expect(resolveRequestPaths({}, base)).toEqual({
      models: '/models',
      chatCompletions: '/chat/completions',
      responses: '/responses',
      messages: '/messages',
    })
  })

  test('resolves a custom path against the base URL\'s origin, dropping its prefix', () => {
    expect(resolveRequestPaths(
      { chatCompletionsPath: '/openai/v1/chat/completions' },
      base,
    ).chatCompletions).toBe('https://example.com/openai/v1/chat/completions')
  })

  test('makes only the endpoints that were configured absolute', () => {
    expect(resolveRequestPaths({ responsesPath: '/openai/v1/responses' }, base)).toEqual({
      models: '/models',
      chatCompletions: '/chat/completions',
      responses: 'https://example.com/openai/v1/responses',
      messages: '/messages',
    })
  })

  test('applies to the models path too', () => {
    expect(resolveRequestPaths({ modelsPath: '/openai/v1/models' }, base).models)
      .toBe('https://example.com/openai/v1/models')
  })

  test('keeps the scheme and port the base URL names', () => {
    expect(resolveRequestPaths({ modelsPath: '/api/models' }, 'http://localhost:11434/v1').models)
      .toBe('http://localhost:11434/api/models')
  })

  test('is unaffected by a trailing slash or a bare origin', () => {
    expect(resolveRequestPaths({ modelsPath: '/api/models' }, 'https://example.com/v1/').models)
      .toBe('https://example.com/api/models')
    expect(resolveRequestPaths({ modelsPath: '/api/models' }, 'https://example.com').models)
      .toBe('https://example.com/api/models')
  })

  test('normalises before resolving, so a stored path missing its slash still works', () => {
    expect(resolveRequestPaths({ modelsPath: 'api/models/' }, base).models)
      .toBe('https://example.com/api/models')
  })

  test('an explicitly typed default path is still absolute — blank is how you inherit', () => {
    expect(resolveRequestPaths({ chatCompletionsPath: '/chat/completions' }, base).chatCompletions)
      .toBe('https://example.com/chat/completions')
  })

  test('falls back to the relative path when there is no base URL to resolve against', () => {
    // No base URL means the SDK's own default, which already carries /v1.
    expect(resolveRequestPaths({ modelsPath: '/api/models' }, null).models).toBe('/api/models')
    expect(resolveRequestPaths({ modelsPath: '/api/models' }, '  ').models).toBe('/api/models')
  })

  test('falls back to the relative path rather than throwing on an unparseable base URL', () => {
    expect(resolveRequestPaths({ modelsPath: '/api/models' }, 'not a url').models)
      .toBe('/api/models')
  })

  test('leaves an unusable stored value on the relative default', () => {
    expect(resolveRequestPaths({ modelsPath: 42 as never }, base).models).toBe('/models')
    expect(resolveRequestPaths({ responsesPath: 'https://x/y' }, base).responses)
      .toBe('/responses')
  })
})

describe('PATH_FIELDS', () => {
  test('describes each endpoint once, keyed by the config key it writes', () => {
    expect(PATH_FIELDS.map((f) => f.name)).toEqual([
      'modelsPath', 'chatCompletionsPath', 'responsesPath', 'messagesPath',
    ])
  })

  test('carries the default as the placeholder, so a blank box reads as "default"', () => {
    expect(PATH_FIELDS.map((f) => f.placeholder)).toEqual([
      '/models', '/chat/completions', '/responses', '/messages',
    ])
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
      { responsesPath: '/api/responses' },
    )).toEqual({ timeoutMs: 5000, registryNamespace: 'xai', responsesPath: '/api/responses' })
  })

  test('does not mutate the config it was handed', () => {
    const config = { modelsPath: '/api/models' }
    mergeProviderPaths(config, { modelsPath: '' })
    expect(config).toEqual({ modelsPath: '/api/models' })
  })

  test('rejects an invalid submission instead of storing it', () => {
    expect(() => mergeProviderPaths({}, { modelsPath: 'https://api.x.ai/v1/models' }))
      .toThrow(/full URL/i)
  })
})

test('messages defaults to /messages and joins onto the base URL', () => {
  const paths = resolveRequestPaths({}, 'https://api.anthropic.com/v1')
  expect(paths.messages).toBe('/messages')
})

test('a configured messages path resolves against the base URL origin', () => {
  const paths = resolveRequestPaths(
    { messagesPath: '/anthropic/v1/messages' },
    'https://gateway.test/openai/v1',
  )
  expect(paths.messages).toBe('https://gateway.test/anthropic/v1/messages')
})

test('the messages path is offered on both the provider and the model forms', () => {
  expect(PATH_FIELDS.map((f) => f.name)).toContain('messagesPath')
  expect(MODEL_PATH_FIELDS.map((f) => f.name)).toContain('messagesPath')
})
