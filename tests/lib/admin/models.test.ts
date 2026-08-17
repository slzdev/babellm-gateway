import { eq } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { routeTargets, virtualModels } from '@/lib/db/schema'
import { createProvider } from '@/lib/admin/providers'
import {
  addRouteTarget, createVirtualModel, deleteVirtualModel, getVirtualModel,
  listVirtualModels, removeRouteTarget, setRouteTargetEnabled, updateRouteTarget, updateVirtualModel,
} from '@/lib/admin/models'
import { resetDb } from '../../helpers/db'

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '2'.repeat(64)
  await resetDb()
})

async function provider(name = 'p') {
  return createProvider({ name, adapter: 'openai', credentials: { apiKey: 'sk-x' } })
}

test('creates a virtual model with failover as the default policy', async () => {
  const model = await createVirtualModel({ name: 'house-model' })
  expect(model.policy).toBe('failover')
  expect(model.maxAttempts).toBe(3)
  expect(model.enabled).toBe(true)
})

test('rejects a duplicate virtual model name with a readable message', async () => {
  await createVirtualModel({ name: 'house-model' })
  // Provokes a real Postgres unique-constraint violation (23505) on
  // virtual_models.name, rather than a pre-check — this pins that the raw
  // pg error never reaches the caller.
  await expect(createVirtualModel({ name: 'house-model' }))
    .rejects.toThrow(/a virtual model named "house-model" already exists/i)
})

test('rejects a virtual model name that is empty or whitespace', async () => {
  await expect(createVirtualModel({ name: '   ' })).rejects.toThrow(/name/i)
})

test('adds targets and lists them ordered by priority with provider names', async () => {
  const [a, b] = [await provider('alpha'), await provider('beta')]
  const model = await createVirtualModel({ name: 'house-model' })

  await addRouteTarget({
    virtualModelId: model.id, providerId: b.id, upstreamModel: 'b-1', priority: 5, weight: 30,
  })
  await addRouteTarget({
    virtualModelId: model.id, providerId: a.id, upstreamModel: 'a-1', priority: 1, weight: 70,
  })

  const [listed] = await listVirtualModels()
  expect(listed.targets.map((t) => t.upstreamModel)).toEqual(['a-1', 'b-1'])
  expect(listed.targets[0].providerName).toBe('alpha')
  expect(listed.targets[0].weight).toBe(70)
})

test('rejects a target with a non-positive weight', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  await expect(
    addRouteTarget({
      virtualModelId: model.id, providerId: p.id, upstreamModel: 'x', weight: 0,
    }),
  ).rejects.toThrow(/weight/i)
})

test('rejects a target with an empty upstream model', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  await expect(
    addRouteTarget({ virtualModelId: model.id, providerId: p.id, upstreamModel: '' }),
  ).rejects.toThrow(/upstream model/i)
})

test('updates the routing policy', async () => {
  const model = await createVirtualModel({ name: 'house-model' })
  const updated = await updateVirtualModel(model.id, { policy: 'weighted' })
  expect(updated.policy).toBe('weighted')
})

test('removing a target leaves the model intact', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'x',
  })

  await removeRouteTarget(target.id)
  expect(await db.select().from(routeTargets)).toHaveLength(0)
  expect(await db.select().from(virtualModels)).toHaveLength(1)
})

test('deleting a virtual model removes its targets', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  await addRouteTarget({ virtualModelId: model.id, providerId: p.id, upstreamModel: 'x' })

  await deleteVirtualModel(model.id)
  expect(await db.select().from(routeTargets)).toHaveLength(0)
  expect(await db.select().from(virtualModels)).toHaveLength(0)
})

test('a route target can be disabled and re-enabled', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'x',
  })

  await setRouteTargetEnabled(target.id, false)
  expect((await listVirtualModels())[0].targets[0].enabled).toBe(false)

  await setRouteTargetEnabled(target.id, true)
  expect((await listVirtualModels())[0].targets[0].enabled).toBe(true)
})

test('rejects a target with a non-integer priority', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  await expect(
    addRouteTarget({
      virtualModelId: model.id, providerId: p.id, upstreamModel: 'x', priority: 1.5,
    }),
  ).rejects.toThrow(/must be an integer/i)
})

test('accepts a negative priority', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'x', priority: -1,
  })
  expect(target.priority).toBe(-1)
})

test('a route target can be edited in place', async () => {
  const provider = await createProvider({
    name: 'p', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const model = await createVirtualModel({ name: 'fast' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o-mimi',
  })

  const updated = await updateRouteTarget(target.id, {
    upstreamModel: 'gpt-4o-mini', priority: 5, weight: 50,
  })

  expect(updated.upstreamModel).toBe('gpt-4o-mini')
  expect(updated.priority).toBe(5)
  expect(updated.weight).toBe(50)
})

test('editing only one field leaves the others alone', async () => {
  const provider = await createProvider({
    name: 'p', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const model = await createVirtualModel({ name: 'fast' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id,
    upstreamModel: 'gpt-4o', priority: 3, weight: 70,
  })

  const updated = await updateRouteTarget(target.id, { weight: 90 })
  expect(updated.upstreamModel).toBe('gpt-4o')
  expect(updated.priority).toBe(3)
  expect(updated.weight).toBe(90)
})

test('an edit is validated the same way an insert is', async () => {
  const provider = await createProvider({
    name: 'p', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const model = await createVirtualModel({ name: 'fast' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: provider.id, upstreamModel: 'gpt-4o',
  })

  await expect(updateRouteTarget(target.id, { upstreamModel: '  ' }))
    .rejects.toThrow(/upstream model name is required/i)
  await expect(updateRouteTarget(target.id, { weight: 0 }))
    .rejects.toThrow(/positive integer/i)
  await expect(updateRouteTarget(target.id, { priority: 1.5 }))
    .rejects.toThrow(/integer/i)
})

test('renaming onto an existing name is refused with a readable message', async () => {
  await createVirtualModel({ name: 'taken' })
  const model = await createVirtualModel({ name: 'mine' })

  await expect(updateVirtualModel(model.id, { name: 'taken' }))
    .rejects.toThrow(/a virtual model named "taken" already exists/i)
})

test('rejects a max attempts value below one', async () => {
  const model = await createVirtualModel({ name: 'house-model' })
  await expect(updateVirtualModel(model.id, { maxAttempts: 0 }))
    .rejects.toThrow(/max attempts/i)
})

test('rejects a non-integer max attempts value', async () => {
  const model = await createVirtualModel({ name: 'house-model' })
  await expect(updateVirtualModel(model.id, { maxAttempts: 2.5 }))
    .rejects.toThrow(/max attempts/i)
})

test('fetches one virtual model with its targets ordered by priority', async () => {
  const [a, b] = [await provider('alpha'), await provider('beta')]
  const model = await createVirtualModel({
    name: 'house-model', description: 'the default', policy: 'weighted',
  })

  await addRouteTarget({
    virtualModelId: model.id, providerId: b.id, upstreamModel: 'b-1', priority: 5,
  })
  await addRouteTarget({
    virtualModelId: model.id, providerId: a.id, upstreamModel: 'a-1', priority: 1,
  })

  const found = await getVirtualModel(model.id)
  expect(found?.name).toBe('house-model')
  expect(found?.description).toBe('the default')
  expect(found?.policy).toBe('weighted')
  expect(found?.targets.map((t) => t.upstreamModel)).toEqual(['a-1', 'b-1'])
  expect(found?.targets[0].providerName).toBe('alpha')
})

test('fetching a virtual model returns only its own targets', async () => {
  const p = await provider()
  const mine = await createVirtualModel({ name: 'mine' })
  const other = await createVirtualModel({ name: 'other' })
  await addRouteTarget({ virtualModelId: mine.id, providerId: p.id, upstreamModel: 'a' })
  await addRouteTarget({ virtualModelId: other.id, providerId: p.id, upstreamModel: 'b' })

  const found = await getVirtualModel(mine.id)
  expect(found?.targets.map((t) => t.upstreamModel)).toEqual(['a'])
})

test('fetching a virtual model that does not exist returns null', async () => {
  expect(await getVirtualModel('00000000-0000-0000-0000-000000000000')).toBeNull()
})

test('editing a target that does not exist is refused', async () => {
  await expect(
    updateRouteTarget('00000000-0000-0000-0000-000000000000', { weight: 10 }),
  ).rejects.toThrow(/not found/i)
})

test('a target has no service tier until one is chosen', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'gpt-4o',
  })

  // Null rather than a string default: "(none)" has to mean "leave the request
  // alone", which no tier value can express.
  expect(target.serviceTier).toBeNull()
})

test('stores the service tier chosen for a target and lists it', async () => {
  const p = await provider('alpha')
  const model = await createVirtualModel({ name: 'house-model' })
  await addRouteTarget({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'gpt-4o', serviceTier: 'flex',
  })

  const [listed] = await listVirtualModels()
  expect(listed.targets[0].serviceTier).toBe('flex')
})

test('rejects a service tier outside the supported set', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  await expect(
    addRouteTarget({
      virtualModelId: model.id, providerId: p.id, upstreamModel: 'gpt-4o',
      serviceTier: 'turbo' as never,
    }),
  ).rejects.toThrow(/service tier/i)
})

test('clears a service tier back to none', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'gpt-4o', serviceTier: 'priority',
  })

  const updated = await updateRouteTarget(target.id, { serviceTier: null })
  expect(updated.serviceTier).toBeNull()
})

test('editing another field leaves the service tier alone', async () => {
  const p = await provider()
  const model = await createVirtualModel({ name: 'house-model' })
  const target = await addRouteTarget({
    virtualModelId: model.id, providerId: p.id, upstreamModel: 'gpt-4o', serviceTier: 'scale',
  })

  const updated = await updateRouteTarget(target.id, { weight: 90 })
  expect(updated.serviceTier).toBe('scale')
})

async function target() {
  const p = await provider('breaker-p')
  const model = await createVirtualModel({ name: 'breaker-model' })
  return addRouteTarget({ virtualModelId: model.id, providerId: p.id, upstreamModel: 'm-1' })
}

test('breaker overrides round-trip, and blank clears back to inherit', async () => {
  const row = await target()

  await updateRouteTarget(row.id, { breakerThreshold: 2, breakerCooldownSeconds: 10 })
  let [saved] = await db.select().from(routeTargets).where(eq(routeTargets.id, row.id))
  expect(saved.breakerThreshold).toBe(2)
  expect(saved.breakerCooldownSeconds).toBe(10)

  // null is how a blank form field says "inherit the global again".
  await updateRouteTarget(row.id, { breakerThreshold: null, breakerCooldownSeconds: null })
  ;[saved] = await db.select().from(routeTargets).where(eq(routeTargets.id, row.id))
  expect(saved.breakerThreshold).toBeNull()
  expect(saved.breakerCooldownSeconds).toBeNull()
})

test('a per-target threshold of 0 is stored, not treated as absent', async () => {
  const row = await target()
  await updateRouteTarget(row.id, { breakerThreshold: 0 })
  const [saved] = await db.select().from(routeTargets).where(eq(routeTargets.id, row.id))
  expect(saved.breakerThreshold).toBe(0)
})

test('an invalid override is rejected rather than stored', async () => {
  const row = await target()
  await expect(updateRouteTarget(row.id, { breakerThreshold: -1 })).rejects.toThrow(/threshold/i)
  await expect(updateRouteTarget(row.id, { breakerCooldownSeconds: 0 })).rejects.toThrow(/cooldown/i)
})
