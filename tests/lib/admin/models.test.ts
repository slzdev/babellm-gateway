import { beforeEach, expect, test } from 'vitest'
import { db } from '@/lib/db'
import { routeTargets, virtualModels } from '@/lib/db/schema'
import { createProvider } from '@/lib/admin/providers'
import {
  addRouteTarget, createVirtualModel, deleteVirtualModel,
  listVirtualModels, removeRouteTarget, setRouteTargetEnabled, updateVirtualModel,
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

test('rejects a duplicate virtual model name', async () => {
  await createVirtualModel({ name: 'house-model' })
  await expect(createVirtualModel({ name: 'house-model' })).rejects.toThrow()
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
