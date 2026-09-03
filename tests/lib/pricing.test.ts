import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { catalogModels, providers } from '@/lib/db/schema'
import { encryptJson } from '@/lib/crypto'
import { clearPriceCache, computeCost, computeInputOnlyCost, priceFor } from '@/lib/pricing'
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

test('an input-only request prices on the input rate alone', () => {
  const cost = computeInputOnlyCost(
    { inputPerMtok: '0.020000', cachedInputPerMtok: null, outputPerMtok: null },
    usage({ promptTokens: 1_000_000, completionTokens: 0 }),
  )
  expect(cost?.inputUsd).toBe('0.020000000')
  expect(cost?.totalUsd).toBe('0.020000000')
})

test('a missing output rate is inapplicable to an input-only request, not a missing price', () => {
  const prices = { inputPerMtok: '0.020000', cachedInputPerMtok: null, outputPerMtok: null }
  // The same catalog row, priced by both rules: an embedding model has no
  // output rate because it has no output, so computeCost is right to refuse it
  // and computeInputOnlyCost is right to charge it.
  expect(computeCost(prices, usage({ completionTokens: 0 }))).toBeNull()
  expect(computeInputOnlyCost(prices, usage({ completionTokens: 0 }))).not.toBeNull()
})

test('an input-only request records a real zero for output, not an unpriced null', () => {
  const cost = computeInputOnlyCost(
    { inputPerMtok: '0.020000', cachedInputPerMtok: null, outputPerMtok: null },
    usage({ promptTokens: 4, completionTokens: 0 }),
  )
  // There were no output tokens — a measurement, not a gap in one — so the
  // component is priced at zero rather than left null.
  expect(cost?.outputUsd).toBe('0.000000000')
  expect(cost?.outputUsd).not.toBeNull()
})

test('cached tokens on an input-only request follow the same subset invariant', () => {
  const cost = computeInputOnlyCost(
    { inputPerMtok: '1.000000', cachedInputPerMtok: '0.250000', outputPerMtok: null },
    usage({ promptTokens: 1_000_000, cachedTokens: 400_000, completionTokens: 0 }),
  )
  expect(cost?.inputUsd).toBe('0.600000000')
  expect(cost?.cachedUsd).toBe('0.100000000')
  expect(cost?.totalUsd).toBe('0.700000000')
})

test('input-only cached tokens fall back to the input rate, and clamp to the prompt count', () => {
  const cost = computeInputOnlyCost(
    { inputPerMtok: '2.000000', cachedInputPerMtok: null, outputPerMtok: null },
    usage({ promptTokens: 100, cachedTokens: 150, completionTokens: 0 }),
  )
  expect(cost?.inputUsd).toBe('0.000000000')
  expect(cost?.cachedUsd).toBe('0.000200000')
  expect(cost?.totalUsd).toBe('0.000200000')
})

test('an input-only request with no input rate or no usage is unpriced, not free', () => {
  expect(computeInputOnlyCost(null, usage({ completionTokens: 0 }))).toBeNull()
  expect(computeInputOnlyCost(
    { inputPerMtok: null, cachedInputPerMtok: '0.010000', outputPerMtok: null },
    usage({ completionTokens: 0 }),
  )).toBeNull()
  expect(computeInputOnlyCost(
    { inputPerMtok: '0.020000', cachedInputPerMtok: null, outputPerMtok: null },
    null,
  )).toBeNull()
  expect(computeInputOnlyCost(
    { inputPerMtok: '0.020000', cachedInputPerMtok: null, outputPerMtok: null },
    usage({ promptTokens: null, completionTokens: 0 }),
  )).toBeNull()
})

test('a measured zero prompt count still prices as an input-only request', () => {
  const cost = computeInputOnlyCost(
    { inputPerMtok: '0.020000', cachedInputPerMtok: null, outputPerMtok: null },
    usage({ promptTokens: 0, completionTokens: 0 }),
  )
  expect(cost).not.toBeNull()
  expect(cost?.totalUsd).toBe('0.000000000')
})

test('an unmeasured completion count does not stop an input-only request pricing', () => {
  // computeCost refuses this, because for chat a null completion count means
  // half the request went unmeasured. Here there is nothing to measure.
  const cost = computeInputOnlyCost(
    { inputPerMtok: '0.020000', cachedInputPerMtok: null, outputPerMtok: null },
    usage({ promptTokens: 1_000_000, completionTokens: null }),
  )
  expect(cost?.totalUsd).toBe('0.020000000')
})

test('the input-only snapshot records the rates actually used', () => {
  const prices = { inputPerMtok: '0.020000', cachedInputPerMtok: '0.005000', outputPerMtok: null }
  expect(computeInputOnlyCost(prices, usage({ completionTokens: 0 }))?.pricing).toEqual(prices)
})
