import { beforeEach, expect, test, vi } from 'vitest'

// The actions are server functions: they revalidate paths and gate on an admin
// session, neither of which exists outside a request. Everything below the
// action — validation, the insert, the column — is the real thing.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/admin/session', () => ({ requireAdmin: vi.fn().mockResolvedValue(undefined) }))

const { addTargetAction, updateTargetAction } = await import('@/app/(admin)/models/actions')
const { createProvider } = await import('@/lib/admin/providers')
const { createVirtualModel, getVirtualModel } = await import('@/lib/admin/models')
const { resetDb } = await import('../../helpers/db')

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '7'.repeat(64)
  await resetDb()
})

async function seed() {
  const provider = await createProvider({
    name: 'p', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })
  const model = await createVirtualModel({ name: 'house-model' })
  return { provider, model }
}

function targetForm(fields: Record<string, string>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return form
}

test('the tier the dialog submits reaches the target', async () => {
  const { provider, model } = await seed()

  // The field name here is the one the ServiceTierSelect renders. A rename on
  // either side has to fail this test rather than silently drop the tier.
  const result = await addTargetAction(undefined, targetForm({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel: 'gpt-4o',
    priority: '0',
    weight: '100',
    serviceTier: 'flex',
  }))

  expect(result.error).toBeUndefined()
  const saved = await getVirtualModel(model.id)
  expect(saved?.targets[0].serviceTier).toBe('flex')
})

test('the "(none)" option stores no tier at all', async () => {
  const { provider, model } = await seed()

  // "(none)" is an <option value="">, so this is exactly what the browser
  // submits for it — not a missing field.
  await addTargetAction(undefined, targetForm({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel: 'gpt-4o',
    priority: '0',
    weight: '100',
    serviceTier: '',
  }))

  const saved = await getVirtualModel(model.id)
  expect(saved?.targets[0].serviceTier).toBeNull()
})

test('editing a target changes its tier', async () => {
  const { provider, model } = await seed()
  await addTargetAction(undefined, targetForm({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel: 'gpt-4o',
    priority: '0',
    weight: '100',
    serviceTier: 'flex',
  }))
  const added = await getVirtualModel(model.id)

  const result = await updateTargetAction(undefined, targetForm({
    id: added!.targets[0].id,
    virtualModelId: model.id,
    upstreamModel: 'gpt-4o',
    priority: '0',
    weight: '100',
    serviceTier: 'priority',
  }))

  expect(result.error).toBeUndefined()
  const saved = await getVirtualModel(model.id)
  expect(saved?.targets[0].serviceTier).toBe('priority')
})

test('editing a target back to "(none)" clears its tier', async () => {
  const { provider, model } = await seed()
  await addTargetAction(undefined, targetForm({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel: 'gpt-4o',
    priority: '0',
    weight: '100',
    serviceTier: 'scale',
  }))
  const added = await getVirtualModel(model.id)

  await updateTargetAction(undefined, targetForm({
    id: added!.targets[0].id,
    virtualModelId: model.id,
    upstreamModel: 'gpt-4o',
    priority: '0',
    weight: '100',
    serviceTier: '',
  }))

  const saved = await getVirtualModel(model.id)
  expect(saved?.targets[0].serviceTier).toBeNull()
})

test('an unknown tier is refused with a readable message', async () => {
  const { provider, model } = await seed()

  const result = await addTargetAction(undefined, targetForm({
    virtualModelId: model.id,
    providerId: provider.id,
    upstreamModel: 'gpt-4o',
    priority: '0',
    weight: '100',
    serviceTier: 'turbo',
  }))

  expect(result.error).toMatch(/service tier/i)
})
