import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  providers, routeTargets, virtualModels,
  type RouteTargetRow, type VirtualModelRow,
} from '@/lib/db/schema'
import { API_FLAVORS, type ApiFlavor } from '@/lib/api-flavors'
import { SERVICE_TIERS, type ServiceTier } from '@/lib/service-tiers'

export type RoutingPolicy = 'failover' | 'weighted' | 'round_robin'

export type { ServiceTier }

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
  serviceTier?: ServiceTier | null
  apiFlavor?: ApiFlavor | null
  enabled?: boolean
  breakerThreshold?: number | null
  breakerCooldownSeconds?: number | null
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
    serviceTier: ServiceTier | null
    apiFlavor: ApiFlavor | null
    enabled: boolean
    breakerThreshold: number | null
    breakerCooldownSeconds: number | null
  }>
}

type TargetRow = { target: RouteTargetRow; providerName: string }

function toListItem(model: VirtualModelRow, rows: TargetRow[]): VirtualModelListItem {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    policy: model.policy,
    maxAttempts: model.maxAttempts,
    enabled: model.enabled,
    targets: rows.map(({ target, providerName }) => ({
      id: target.id,
      providerId: target.providerId,
      providerName,
      upstreamModel: target.upstreamModel,
      priority: target.priority,
      weight: target.weight,
      serviceTier: target.serviceTier,
      apiFlavor: target.apiFlavor,
      enabled: target.enabled,
      breakerThreshold: target.breakerThreshold,
      breakerCooldownSeconds: target.breakerCooldownSeconds,
    })),
  }
}

export async function listVirtualModels(): Promise<VirtualModelListItem[]> {
  const models = await db.select().from(virtualModels).orderBy(asc(virtualModels.name))
  const rows = await db
    .select({ target: routeTargets, providerName: providers.name })
    .from(routeTargets)
    .innerJoin(providers, eq(routeTargets.providerId, providers.id))
    .orderBy(asc(routeTargets.priority), asc(routeTargets.createdAt))

  return models.map((model) => toListItem(
    model,
    rows.filter(({ target }) => target.virtualModelId === model.id),
  ))
}

export async function getVirtualModel(id: string): Promise<VirtualModelListItem | null> {
  const [model] = await db.select().from(virtualModels).where(eq(virtualModels.id, id))
  if (!model) return null

  const rows = await db
    .select({ target: routeTargets, providerName: providers.name })
    .from(routeTargets)
    .innerJoin(providers, eq(routeTargets.providerId, providers.id))
    .where(eq(routeTargets.virtualModelId, id))
    .orderBy(asc(routeTargets.priority), asc(routeTargets.createdAt))

  return toListItem(model, rows)
}

/**
 * node-postgres surfaces a Postgres error as a plain object with a `code`,
 * but drizzle wraps it in a DrizzleQueryError and moves the original onto
 * `.cause` — so the 23505 (unique_violation) can be on the error itself or
 * one `.cause` down, depending on which layer threw.
 */
function isUniqueViolation(err: unknown): boolean {
  const hasCode = (e: unknown): e is { code: string } =>
    typeof e === 'object' && e !== null && 'code' in e
  if (hasCode(err) && err.code === '23505') return true
  const cause = err instanceof Error ? err.cause : undefined
  return hasCode(cause) && cause.code === '23505'
}

function validateName(value: string): string {
  const name = value.trim()
  if (!name) throw new Error('A virtual model name is required.')
  return name
}

function validateMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Max attempts must be a positive integer.')
  }
  return value
}

/** Null is a value here — it means "inherit the global" — so only a supplied
 *  number is checked. 0 is legal and disables the breaker for this target. */
function validateBreakerThreshold(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('The breaker threshold must be a whole number of failures, 0 or more.')
  }
  return value
}

function validateBreakerCooldown(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('The breaker cooldown must be a whole number of seconds, 1 or more.')
  }
  return value
}

export async function createVirtualModel(input: VirtualModelInput): Promise<VirtualModelRow> {
  const name = validateName(input.name)
  const maxAttempts = validateMaxAttempts(input.maxAttempts ?? 3)

  try {
    const [row] = await db.insert(virtualModels).values({
      name,
      description: input.description ?? null,
      policy: input.policy ?? 'failover',
      maxAttempts,
      enabled: input.enabled ?? true,
    }).returning()
    return row
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error(`A virtual model named "${name}" already exists.`)
    throw err
  }
}

export async function updateVirtualModel(
  id: string,
  input: Partial<VirtualModelInput>,
): Promise<VirtualModelRow> {
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (input.name !== undefined) patch.name = validateName(input.name)
  if (input.description !== undefined) patch.description = input.description
  if (input.policy !== undefined) patch.policy = input.policy
  if (input.maxAttempts !== undefined) patch.maxAttempts = validateMaxAttempts(input.maxAttempts)
  if (input.enabled !== undefined) patch.enabled = input.enabled

  // A rename can collide with another model's name just as an insert can —
  // the detail page's settings form is the first thing to make that reachable.
  try {
    const [row] = await db.update(virtualModels).set(patch)
      .where(eq(virtualModels.id, id)).returning()
    if (!row) throw new Error('Virtual model not found.')
    return row
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error(`A virtual model named "${patch.name}" already exists.`)
    }
    throw err
  }
}

export async function deleteVirtualModel(id: string): Promise<void> {
  await db.delete(virtualModels).where(eq(virtualModels.id, id))
}

function validateTargetFields(input: {
  upstreamModel?: string
  priority?: number
  weight?: number
  serviceTier?: ServiceTier | null
  apiFlavor?: ApiFlavor | null
  breakerThreshold?: number | null
  breakerCooldownSeconds?: number | null
}) {
  const patch: {
    upstreamModel?: string
    priority?: number
    weight?: number
    serviceTier?: ServiceTier | null
    apiFlavor?: ApiFlavor | null
    breakerThreshold?: number | null
    breakerCooldownSeconds?: number | null
  } = {}

  if (input.upstreamModel !== undefined) {
    const upstreamModel = input.upstreamModel.trim()
    if (!upstreamModel) throw new Error('An upstream model name is required.')
    patch.upstreamModel = upstreamModel
  }
  if (input.weight !== undefined) {
    if (!Number.isInteger(input.weight) || input.weight < 1) {
      throw new Error('Target weight must be a positive integer.')
    }
    patch.weight = input.weight
  }
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority)) {
      throw new Error('Target priority must be an integer.')
    }
    patch.priority = input.priority
  }
  // `null` is a value here, not an omission: it clears the tier back to
  // "(none)". Only `undefined` means "leave this field alone".
  if (input.serviceTier !== undefined) {
    if (input.serviceTier !== null && !SERVICE_TIERS.includes(input.serviceTier)) {
      throw new Error(`"${input.serviceTier}" is not a supported service tier.`)
    }
    patch.serviceTier = input.serviceTier
  }
  // `null` means "inherit the provider's flavor" — a real, distinct setting,
  // not an omission. Only `undefined` leaves this field alone.
  if (input.apiFlavor !== undefined) {
    if (input.apiFlavor !== null && !API_FLAVORS.includes(input.apiFlavor)) {
      throw new Error(`"${input.apiFlavor}" is not a supported API flavor.`)
    }
    patch.apiFlavor = input.apiFlavor
  }
  if (input.breakerThreshold !== undefined) {
    patch.breakerThreshold = validateBreakerThreshold(input.breakerThreshold)
  }
  if (input.breakerCooldownSeconds !== undefined) {
    patch.breakerCooldownSeconds = validateBreakerCooldown(input.breakerCooldownSeconds)
  }

  return patch
}

export async function addRouteTarget(input: RouteTargetInput): Promise<RouteTargetRow> {
  const validated = validateTargetFields({
    upstreamModel: input.upstreamModel,
    priority: input.priority ?? 0,
    weight: input.weight ?? 100,
    serviceTier: input.serviceTier ?? null,
    apiFlavor: input.apiFlavor ?? null,
    breakerThreshold: input.breakerThreshold,
    breakerCooldownSeconds: input.breakerCooldownSeconds,
  })

  const [row] = await db.insert(routeTargets).values({
    virtualModelId: input.virtualModelId,
    providerId: input.providerId,
    upstreamModel: validated.upstreamModel!,
    priority: validated.priority!,
    weight: validated.weight!,
    serviceTier: validated.serviceTier ?? null,
    apiFlavor: validated.apiFlavor ?? null,
    enabled: input.enabled ?? true,
    breakerThreshold: validated.breakerThreshold ?? null,
    breakerCooldownSeconds: validated.breakerCooldownSeconds ?? null,
  }).returning()
  return row
}

export async function updateRouteTarget(
  id: string,
  input: {
    upstreamModel?: string
    priority?: number
    weight?: number
    serviceTier?: ServiceTier | null
    apiFlavor?: ApiFlavor | null
    enabled?: boolean
    breakerThreshold?: number | null
    breakerCooldownSeconds?: number | null
  },
): Promise<RouteTargetRow> {
  const patch: Record<string, unknown> = validateTargetFields(input)
  if (input.enabled !== undefined) patch.enabled = input.enabled

  const [row] = await db.update(routeTargets).set(patch)
    .where(eq(routeTargets.id, id)).returning()
  if (!row) throw new Error('Route target not found.')
  return row
}

export async function removeRouteTarget(id: string): Promise<void> {
  await db.delete(routeTargets).where(eq(routeTargets.id, id))
}

export async function setRouteTargetEnabled(id: string, enabled: boolean): Promise<void> {
  const [row] = await db.update(routeTargets).set({ enabled })
    .where(eq(routeTargets.id, id)).returning()
  if (!row) throw new Error('Route target not found.')
}
