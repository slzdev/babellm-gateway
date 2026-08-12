import { expect, test } from 'vitest'
import { loadSeed, loadSeedProviders } from '@/lib/catalog/seed'
import { projectModelsDev } from '@/lib/catalog/registry'
import fixture from '../../fixtures/models-dev.json'

test('the vendored snapshot loads through the same projection as the registry', () => {
  // The seed's whole purpose is being the same shape from a different source.
  // If refresh-seed.mjs ever writes something else, this is what catches it.
  const seed = loadSeed()
  const live = projectModelsDev(fixture)

  const seedEntry = seed['openai/gpt-4o']
  expect(seedEntry).toBeDefined()
  expect(Object.keys(seedEntry).sort()).toEqual(Object.keys(live['openai/gpt-4o']).sort())
})

test('the snapshot covers every adapter namespace the normalizer targets', () => {
  const seed = loadSeed()
  const namespaces = new Set(Object.keys(seed).map((key) => key.split('/')[0]))

  expect(namespaces.has('openai')).toBe(true)
  expect(namespaces.has('google')).toBe(true)
  expect(namespaces.has('amazon-bedrock')).toBe(true)
})

test('the snapshot carries real pricing and limits', () => {
  const entry = loadSeed()['openai/gpt-4o']
  expect(entry.contextWindow).toBeGreaterThan(0)
  expect(entry.inputPerMtok).toBeGreaterThan(0)
  expect(entry.kind).toBe('chat')
})

test('loading is memoized so repeated syncs do not re-parse megabytes', () => {
  expect(loadSeed()).toBe(loadSeed())
})

test('the snapshot exposes its provider namespaces with display names', () => {
  const namespaces = loadSeedProviders()

  expect(namespaces.length).toBeGreaterThan(100)
  expect(namespaces).toContainEqual({ slug: 'xai', name: 'xAI' })
  expect(namespaces).toContainEqual({ slug: 'openai', name: 'OpenAI' })
})

test('provider namespaces come back sorted, so the picker lists them predictably', () => {
  const slugs = loadSeedProviders().map((namespace) => namespace.slug)

  expect(slugs).toEqual([...slugs].sort((a, b) => a.localeCompare(b)))
})

test('loading providers is memoized like the index it sits beside', () => {
  expect(loadSeedProviders()).toBe(loadSeedProviders())
})
