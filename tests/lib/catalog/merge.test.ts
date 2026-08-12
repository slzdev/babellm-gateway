import { expect, test } from 'vitest'
import { inferKindFromId, mergeCatalogFields } from '@/lib/catalog/merge'

test('override beats every other layer, field by field', () => {
  const { effective, sources } = mergeCatalogFields({
    override: { contextWindow: 64000 },
    discovered: { contextWindow: 128000, maxOutputTokens: 4096 },
    registry: { contextWindow: 128000, inputPerMtok: 2.5 },
    seed: { contextWindow: 128000, inputPerMtok: 2.4 },
  }, 'gpt-4o')

  expect(effective.contextWindow).toBe(64000)
  expect(sources.contextWindow).toBe('override')
  expect(effective.maxOutputTokens).toBe(4096)
  expect(sources.maxOutputTokens).toBe('discovered')
  expect(effective.inputPerMtok).toBe(2.5)
  expect(sources.inputPerMtok).toBe('registry')
})

test('precedence falls through in order when a layer omits a field', () => {
  const { effective, sources } = mergeCatalogFields({
    discovered: {},
    registry: { outputPerMtok: 10 },
    seed: { outputPerMtok: 9, cachedInputPerMtok: 1.25 },
  }, 'gpt-4o')

  expect(effective.outputPerMtok).toBe(10)
  expect(sources.outputPerMtok).toBe('registry')
  expect(effective.cachedInputPerMtok).toBe(1.25)
  expect(sources.cachedInputPerMtok).toBe('seed')
})

test('a cleared override falls through rather than to null', () => {
  const withOverride = mergeCatalogFields({
    override: { contextWindow: 64000 }, registry: { contextWindow: 128000 },
  }, 'gpt-4o')
  expect(withOverride.effective.contextWindow).toBe(64000)

  // Clearing removes the key entirely — it does not write null.
  const cleared = mergeCatalogFields({
    override: {}, registry: { contextWindow: 128000 },
  }, 'gpt-4o')
  expect(cleared.effective.contextWindow).toBe(128000)
  expect(cleared.sources.contextWindow).toBe('registry')
})

test('an explicit null in a layer is treated as absent', () => {
  const { effective, sources } = mergeCatalogFields({
    discovered: { contextWindow: null }, seed: { contextWindow: 8192 },
  }, 'whatever')

  expect(effective.contextWindow).toBe(8192)
  expect(sources.contextWindow).toBe('seed')
})

test('a field no layer supplies is null with no source', () => {
  const { effective, sources } = mergeCatalogFields({ discovered: {} }, 'mystery-model')
  expect(effective.supportsStreaming).toBeNull()
  expect(sources.supportsStreaming).toBeUndefined()
})

test('false and zero are real values, not absences', () => {
  const { effective, sources } = mergeCatalogFields({
    discovered: { supportsTools: false, outputPerMtok: 0 },
    registry: { supportsTools: true, outputPerMtok: 10 },
  }, 'text-embedding-3-small')

  expect(effective.supportsTools).toBe(false)
  expect(sources.supportsTools).toBe('discovered')
  expect(effective.outputPerMtok).toBe(0)
  expect(sources.outputPerMtok).toBe('discovered')
})

test('kind comes from the highest layer that claims to know', () => {
  const { effective, sources } = mergeCatalogFields({
    registry: { kind: 'embedding' }, seed: { kind: 'chat' },
  }, 'text-embedding-3-small')

  expect(effective.kind).toBe('embedding')
  expect(sources.kind).toBe('registry')
})

test("a layer's 'unknown' kind does not block a lower layer", () => {
  const { effective, sources } = mergeCatalogFields({
    discovered: { kind: 'unknown' }, registry: { kind: 'chat' },
  }, 'gpt-4o')

  expect(effective.kind).toBe('chat')
  expect(sources.kind).toBe('registry')
})

test('the id heuristic runs only after all four layers miss', () => {
  const { effective, sources } = mergeCatalogFields({}, 'text-embedding-3-small')
  expect(effective.kind).toBe('embedding')
  expect(sources.kind).toBe('heuristic')
})

test('the heuristic classifies the kinds discovery cannot', () => {
  expect(inferKindFromId('text-embedding-3-small')).toBe('embedding')
  expect(inferKindFromId('whisper-1')).toBe('audio')
  expect(inferKindFromId('tts-1-hd')).toBe('audio')
  expect(inferKindFromId('dall-e-3')).toBe('image')
  expect(inferKindFromId('imagen-4-fast')).toBe('image')
  expect(inferKindFromId('veo-3')).toBe('video')
})

test('an unrecognised id is unknown, not chat', () => {
  // The picker groups unknown last; guessing "chat" would hide a wrong guess.
  expect(inferKindFromId('ft:gpt-4o:acme:x2')).toBe('unknown')
  expect(inferKindFromId('llama3.1:8b')).toBe('unknown')
})
