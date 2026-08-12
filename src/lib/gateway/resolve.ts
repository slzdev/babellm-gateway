import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  providers, routeTargets, virtualModels,
  type ProviderRow, type VirtualModelRow,
} from '@/lib/db/schema'
import { GatewayError } from './errors'

export interface Candidate {
  targetId: string
  provider: ProviderRow
  upstreamModel: string
  // Not used by Phase 1's single-target routing, but weighted selection
  // (Phase 2) cannot be built without weight on this shape — carrying it
  // now means adding it later isn't a signature change.
  priority: number
  weight: number
}

export interface ResolvedModel {
  model: VirtualModelRow
  candidates: Candidate[]
}

export async function resolveVirtualModel(name: string): Promise<ResolvedModel> {
  const [model] = await db
    .select()
    .from(virtualModels)
    .where(and(eq(virtualModels.name, name), eq(virtualModels.enabled, true)))
    .limit(1)

  if (!model) {
    throw new GatewayError({
      status: 404,
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
      message: `The model \`${name}\` does not exist.`,
    })
  }

  const rows = await db
    .select({ target: routeTargets, provider: providers })
    .from(routeTargets)
    .innerJoin(providers, eq(routeTargets.providerId, providers.id))
    .where(
      and(
        eq(routeTargets.virtualModelId, model.id),
        eq(routeTargets.enabled, true),
        eq(providers.enabled, true),
      ),
    )
    .orderBy(asc(routeTargets.priority), asc(routeTargets.createdAt), asc(routeTargets.id))

  if (rows.length === 0) {
    throw new GatewayError({
      status: 503,
      type: 'api_error',
      code: 'no_targets_available',
      message: `The model \`${name}\` has no enabled route targets.`,
    })
  }

  return {
    model,
    candidates: rows.map(({ target, provider }) => ({
      targetId: target.id,
      provider,
      upstreamModel: target.upstreamModel,
      priority: target.priority,
      weight: target.weight,
    })),
  }
}
