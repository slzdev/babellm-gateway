import { beforeEach, expect, test } from 'vitest'
import {
  DEFAULT_REGISTRY_URL, getCatalogSettings, setCatalogSettings,
} from '@/lib/settings'
import { resetDb } from '../helpers/db'

beforeEach(resetDb)

test('defaults to the registry enabled at models.dev', async () => {
  const settings = await getCatalogSettings()
  expect(settings.registryEnabled).toBe(true)
  expect(settings.registryUrl).toBe(DEFAULT_REGISTRY_URL)
  expect(DEFAULT_REGISTRY_URL).toBe('https://models.dev/api.json')
})

test('a stored false survives the default', async () => {
  await setCatalogSettings({ registryEnabled: false })
  expect((await getCatalogSettings()).registryEnabled).toBe(false)
})

test('setting one key leaves the other alone', async () => {
  await setCatalogSettings({ registryUrl: 'https://mirror.internal/api.json' })
  const settings = await getCatalogSettings()
  expect(settings.registryUrl).toBe('https://mirror.internal/api.json')
  expect(settings.registryEnabled).toBe(true)
})

test('writing the same key twice updates rather than conflicts', async () => {
  await setCatalogSettings({ registryEnabled: false })
  const settings = await setCatalogSettings({ registryEnabled: true })
  expect(settings.registryEnabled).toBe(true)
})

test('a malformed or empty registry URL is refused', async () => {
  await expect(setCatalogSettings({ registryUrl: 'not a url' })).rejects.toThrow(/valid URL/i)
  await expect(setCatalogSettings({ registryUrl: '   ' })).rejects.toThrow(/required/i)
})
