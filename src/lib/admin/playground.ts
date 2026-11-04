import 'server-only'
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, users, catalogModels, providers, routeTargets, virtualModels } from '@/lib/db/schema'

export type PlaygroundApiKeyOption = {
  id: string
  name: string
  keyPrefix: string
  userName: string | null
}

export async function listPlaygroundApiKeys(): Promise<PlaygroundApiKeyOption[]> {
  return db.select({
    id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix, userName: users.name,
  })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .where(and(
      eq(apiKeys.enabled, true),
      or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
    ))
    .orderBy(asc(apiKeys.name), asc(apiKeys.id))
}

export type PlaygroundModelOption = { value: string; label: string; group: string }

export async function listPlaygroundModels(): Promise<PlaygroundModelOption[]> {
  const [models, targets, directModels] = await Promise.all([
    db.select({ id: virtualModels.id, name: virtualModels.name })
      .from(virtualModels)
      .where(eq(virtualModels.enabled, true))
      .orderBy(asc(virtualModels.name)),
    db.select({ virtualModelId: routeTargets.virtualModelId })
      .from(routeTargets)
      .innerJoin(providers, eq(routeTargets.providerId, providers.id))
      .leftJoin(catalogModels, and(
        eq(catalogModels.providerId, routeTargets.providerId),
        eq(catalogModels.modelId, routeTargets.upstreamModel),
      ))
      .where(and(
        eq(routeTargets.enabled, true), eq(providers.enabled, true),
        or(isNull(catalogModels.id), inArray(catalogModels.kind, ['chat', 'unknown'])),
      )),
    db.select({ providerName: providers.name, modelId: catalogModels.modelId })
      .from(catalogModels)
      .innerJoin(providers, eq(catalogModels.providerId, providers.id))
      .where(and(eq(providers.enabled, true), inArray(catalogModels.kind, ['chat', 'unknown'])))
      .orderBy(asc(providers.name), asc(catalogModels.modelId)),
  ])

  const eligible = new Set(targets.map((target) => target.virtualModelId))
  // The gateway resolves every enabled virtual name before trying a direct
  // address, including virtual models with no usable chat targets.
  const shadowed = new Set(models.map((model) => model.name))
  return [
    ...models.filter((model) => eligible.has(model.id)).map((model) => ({
      value: model.name, label: model.name, group: 'Virtual models',
    })),
    ...directModels.flatMap(({ providerName, modelId }) => {
      const value = `${providerName}/${modelId}`
      return shadowed.has(value) ? [] : [{ value, label: modelId, group: providerName }]
    }),
  ]
}
