import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { catalogModels, providers } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { clearPriceCache, computeCost, priceFor } from '@/lib/pricing'
import type { LogUsage } from '@/lib/logs/types'
import { resetDb } from '../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  await resetDb()
  clearPriceCache()
})

const usage = (over: Partial<LogUsage> = {}): LogUsage => ({
  promptTokens: 1_000_000, completionTokens: 1_000_000,
  cachedTokens: null, reasoningTokens: null, ...over,
})

test('prices a request at the catalog rates', () => {
  const cost = computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '3.000000' },
    usage(),
  )
  expect(cost?.inputUsd).toBe('1.000000000')
  expect(cost?.outputUsd).toBe('3.000000000')
  expect(cost?.totalUsd).toBe('4.000000000')
})

test('cached tokens are billed at the cached rate and removed from the input count', () => {
  const cost = computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: '0.250000', outputPerMtok: '0' },
    usage({ promptTokens: 1_000_000, cachedTokens: 400_000, completionTokens: 0 }),
  )
  // 600k at full rate + 400k at the cached rate — not 1M at full rate plus a
  // second charge for the cached slice.
  expect(cost?.inputUsd).toBe('0.600000000')
  expect(cost?.cachedUsd).toBe('0.100000000')
  expect(cost?.totalUsd).toBe('0.700000000')
})

test('cached tokens fall back to the input rate when the catalog has no cached price', () => {
  const cost = computeCost(
    { inputPerMtok: '2.000000', cachedInputPerMtok: null, outputPerMtok: '0' },
    usage({ promptTokens: 1_000_000, cachedTokens: 500_000, completionTokens: 0 }),
  )
  expect(cost?.cachedUsd).toBe('1.000000000')
  expect(cost?.totalUsd).toBe('2.000000000')
})

test('cached tokens beyond the reported prompt count are clamped, not overbilled', () => {
  const cost = computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: '0.250000', outputPerMtok: '0' },
    usage({ promptTokens: 100, cachedTokens: 150, completionTokens: 0 }),
  )
  // Cached is a subset of prompt, so a provider reporting more cached than
  // prompt tokens can only mean the whole prompt was cached — 100 tokens at
  // the cached rate, nothing at the full input rate.
  expect(cost?.inputUsd).toBe('0.000000000')
  expect(cost?.cachedUsd).toBe('0.000025000')
  expect(cost?.totalUsd).toBe('0.000025000')
})

test('a sub-micro-dollar request keeps its value instead of rounding to zero', () => {
  const cost = computeCost(
    { inputPerMtok: '0.100000', cachedInputPerMtok: null, outputPerMtok: '0' },
    usage({ promptTokens: 1, completionTokens: 0 }),
  )
  expect(Number(cost?.totalUsd)).toBeGreaterThan(0)
})

test('no prices means unpriced, not free', () => {
  expect(computeCost(null, usage())).toBeNull()
  expect(computeCost(
    { inputPerMtok: null, cachedInputPerMtok: null, outputPerMtok: '1.000000' },
    usage(),
  )).toBeNull()
})

test('no usage means unpriced', () => {
  expect(computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '1.000000' },
    null,
  )).toBeNull()
  expect(computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '1.000000' },
    usage({ promptTokens: null, completionTokens: null }),
  )).toBeNull()
})

test('one side missing means unpriced, not half a price', () => {
  const prices = { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '1.000000' }
  expect(computeCost(prices, usage({ promptTokens: null, completionTokens: 500 }))).toBeNull()
  expect(computeCost(prices, usage({ promptTokens: 500, completionTokens: null }))).toBeNull()
})

test('a measured zero on one side still prices normally', () => {
  const cost = computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '1.000000' },
    usage({ promptTokens: 500, completionTokens: 0 }),
  )
  expect(cost).not.toBeNull()
  expect(cost?.outputUsd).toBe('0.000000000')
})

test('a priceable request with no cached tokens records a real zero, not null', () => {
  const cost = computeCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: '0.250000', outputPerMtok: '1.000000' },
    usage({ cachedTokens: null }),
  )
  // null stays reserved for "the catalog could not price this" — a
  // measured absence of cache hits is a real, priced zero, the same way a
  // measured zero on prompt or completion tokens prices normally.
  expect(cost?.cachedUsd).toBe('0.000000000')
  expect(cost?.cachedUsd).not.toBeNull()
})

test('the snapshot records the rates actually used', () => {
  const prices = { inputPerMtok: '1.000000', cachedInputPerMtok: null, outputPerMtok: '3.000000' }
  expect(computeCost(prices, usage())?.pricing).toEqual(prices)
})

test('priceFor reads the catalog by provider and upstream model', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'p', adapter: 'openai', credentials: encryptJson({ apiKey: 'x' }),
  }).returning()

  await db.insert(catalogModels).values({
    providerId: provider.id, modelId: 'gpt-4o-mini',
    inputPerMtok: '0.150000', outputPerMtok: '0.600000',
  })

  expect(await priceFor(provider.id, 'gpt-4o-mini')).toEqual({
    inputPerMtok: '0.150000', cachedInputPerMtok: null, outputPerMtok: '0.600000',
  })
  expect(await priceFor(provider.id, 'not-in-catalog')).toBeNull()
})
