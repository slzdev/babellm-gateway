import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  providers, routeTargets, virtualModels,
  type RouteTargetRow, type VirtualModelRow,
} from '@/lib/db/schema'

export type RoutingPolicy = 'failover' | 'weighted' | 'round_robin'

export interface VirtualModelInput {
  name: string
  description?: string | null
  policy?: RoutingPolicy
  maxAttempts?: number
  enabled?: boolean
}

export interface RouteTargetInput {
  virtualModelId: string
  providerId: string
  upstreamModel: string
  priority?: number
  weight?: number
  enabled?: boolean
}

export interface VirtualModelListItem {
  id: string
  name: string
  description: string | null
  policy: RoutingPolicy
  maxAttempts: number
  enabled: boolean
  targets: Array<{
    id: string
    providerId: string
    providerName: string
    upstreamModel: string
    priority: number
    weight: number
    enabled: boolean
  }>
}

export async function listVirtualModels(): Promise<VirtualModelListItem[]> {
  const models = await db.select().from(virtualModels).orderBy(asc(virtualModels.name))
  const rows = await db
    .select({ target: routeTargets, providerName: providers.name })
    .from(routeTargets)
    .innerJoin(providers, eq(routeTargets.providerId, providers.id))
    .orderBy(asc(routeTargets.priority), asc(routeTargets.createdAt))

  return models.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    policy: model.policy,
    maxAttempts: model.maxAttempts,
    enabled: model.enabled,
    targets: rows
      .filter(({ target }) => target.virtualModelId === model.id)
      .map(({ target, providerName }) => ({
        id: target.id,
        providerId: target.providerId,
        providerName,
        upstreamModel: target.upstreamModel,
        priority: target.priority,
        weight: target.weight,
        enabled: target.enabled,
      })),
  }))
}

export async function createVirtualModel(input: VirtualModelInput): Promise<VirtualModelRow> {
  const name = input.name.trim()
  if (!name) throw new Error('A virtual model name is required.')

  const [row] = await db.insert(virtualModels).values({
    name,
    description: input.description ?? null,
    policy: input.policy ?? 'failover',
    maxAttempts: input.maxAttempts ?? 3,
    enabled: input.enabled ?? true,
  }).returning()
  return row
}

export async function updateVirtualModel(
  id: string,
  input: Partial<VirtualModelInput>,
): Promise<VirtualModelRow> {
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error('A virtual model name is required.')
    patch.name = name
  }
  if (input.description !== undefined) patch.description = input.description
  if (input.policy !== undefined) patch.policy = input.policy
  if (input.maxAttempts !== undefined) patch.maxAttempts = input.maxAttempts
  if (input.enabled !== undefined) patch.enabled = input.enabled

  const [row] = await db.update(virtualModels).set(patch)
    .where(eq(virtualModels.id, id)).returning()
  if (!row) throw new Error('Virtual model not found.')
  return row
}

export async function deleteVirtualModel(id: string): Promise<void> {
  await db.delete(virtualModels).where(eq(virtualModels.id, id))
}

export async function addRouteTarget(input: RouteTargetInput): Promise<RouteTargetRow> {
  const upstreamModel = input.upstreamModel.trim()
  if (!upstreamModel) throw new Error('An upstream model name is required.')

  const weight = input.weight ?? 100
  if (!Number.isInteger(weight) || weight < 1) {
    throw new Error('Target weight must be a positive integer.')
  }

  const [row] = await db.insert(routeTargets).values({
    virtualModelId: input.virtualModelId,
    providerId: input.providerId,
    upstreamModel,
    priority: input.priority ?? 0,
    weight,
    enabled: input.enabled ?? true,
  }).returning()
  return row
}

export async function removeRouteTarget(id: string): Promise<void> {
  await db.delete(routeTargets).where(eq(routeTargets.id, id))
}
