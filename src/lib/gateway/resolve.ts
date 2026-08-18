import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  catalogModels, providers, routeTargets, virtualModels,
  type ProviderRow,
} from '@/lib/db/schema'
import type { ApiFlavor } from '@/lib/api-flavors'
import type { ServiceTier } from '@/lib/service-tiers'
import { GatewayError } from './errors'
import type { SelectableModel } from './select'

export interface Candidate {
  targetId: string
  provider: ProviderRow
  upstreamModel: string
  // Not used by Phase 1's single-target routing, but weighted selection
  // (Phase 2) cannot be built without weight on this shape — carrying it
  // now means adding it later isn't a signature change.
  priority: number
  weight: number
  /** The tier this target pins `service_tier` to, or null to forward the
   * client's body untouched. */
  serviceTier: ServiceTier | null
  /** The protocol this target's endpoint speaks. Resolved rather than
   *  nullable: the routing loop must never have to work out where the
   *  answer came from. */
  apiFlavor: ApiFlavor
  /**
   * Whether an open breaker may demote this candidate.
   *
   * False for a direct `provider/model` address: `targetId` there is a
   * catalog_models id, the chain has exactly one link, and demoting the only
   * link could only convert a request that might have succeeded into a
   * guaranteed failure.
   */
  breakable: boolean
  /** Per-target breaker overrides. NULL inherits the global setting. */
  breakerThreshold: number | null
  breakerCooldownSeconds: number | null
}

export interface ResolvedModel {
  // Only the fields selection reads, so a direct `provider/model` address can
  // synthesize one without inventing a whole virtual_models row.
  model: SelectableModel
  candidates: Candidate[]
}

function modelNotFound(name: string): GatewayError {
  return new GatewayError({
    status: 404,
    type: 'invalid_request_error',
    code: 'model_not_found',
    param: 'model',
    message: `The model \`${name}\` does not exist.`,
  })
}

/**
 * Resolves the `model` field of a request to the chain of targets to try.
 *
 * A name is first looked up as a virtual model. Only if that misses does a
 * name containing a slash get read as a direct `provider/model` address — so
 * naming a virtual model `openai/gpt-5` shadows the direct route rather than
 * being unreachable behind it.
 */
export async function resolveModel(name: string): Promise<ResolvedModel> {
  const virtual = await findVirtualModel(name)
  if (virtual) return virtual

  const slash = name.indexOf('/')
  // Split on the FIRST slash: provider names have none, and model ids very
  // much do (`meta-llama/Llama-3-70b`), so everything after it is the model.
  if (slash > 0) return resolveDirect(name, name.slice(0, slash), name.slice(slash + 1))

  throw modelNotFound(name)
}

async function findVirtualModel(name: string): Promise<ResolvedModel | null> {
  const [model] = await db
    .select()
    .from(virtualModels)
    .where(and(eq(virtualModels.name, name), eq(virtualModels.enabled, true)))
    .limit(1)

  if (!model) return null

  const rows = await db
    .select({ target: routeTargets, provider: providers, catalog: catalogModels })
    .from(routeTargets)
    .innerJoin(providers, eq(routeTargets.providerId, providers.id))
    // Left, not inner: upstream_model is free text, so a target may name a
    // model the catalog has never seen. That target keeps routing on the
    // provider's settings rather than dropping out of the chain.
    .leftJoin(
      catalogModels,
      and(
        eq(catalogModels.providerId, routeTargets.providerId),
        eq(catalogModels.modelId, routeTargets.upstreamModel),
      ),
    )
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
    candidates: rows.map(({ target, provider, catalog }) => ({
      targetId: target.id,
      provider,
      upstreamModel: target.upstreamModel,
      priority: target.priority,
      weight: target.weight,
      serviceTier: target.serviceTier,
      apiFlavor: catalog?.apiFlavor ?? provider.apiFlavor,
      breakable: true,
      breakerThreshold: target.breakerThreshold,
      breakerCooldownSeconds: target.breakerCooldownSeconds,
    })),
  }
}

/**
 * Routes `provider/model` to a single catalog entry on that provider.
 *
 * The catalog is the allow-list: only a model the provider has actually been
 * seen to serve (or that an admin added by hand) can be addressed this way,
 * so a typo answers 404 here instead of costing a round trip to an upstream
 * that would reject it anyway. `status` is deliberately not filtered on — a
 * sync failure marks rows missing rather than deleting them, and a provider
 * having a bad day must not take a real model off the air.
 */
async function resolveDirect(
  name: string,
  providerName: string,
  modelId: string,
): Promise<ResolvedModel> {
  const [row] = await db
    .select({ catalog: catalogModels, provider: providers })
    .from(catalogModels)
    .innerJoin(providers, eq(catalogModels.providerId, providers.id))
    .where(and(eq(providers.name, providerName), eq(catalogModels.modelId, modelId)))
    .limit(1)

  if (!row) throw modelNotFound(name)

  // A disabled provider is an operator decision, not a bad request — same
  // answer a virtual model whose every target is disabled would give.
  if (!row.provider.enabled) {
    throw new GatewayError({
      status: 503,
      type: 'api_error',
      code: 'no_targets_available',
      message: `The provider \`${providerName}\` is disabled.`,
    })
  }

  return {
    // One candidate, so the chain must not consult a round-robin cursor or
    // draw weights: failover over a single target is the only honest policy.
    model: { id: row.catalog.id, policy: 'failover', maxAttempts: 1 },
    candidates: [{
      targetId: row.catalog.id,
      provider: row.provider,
      upstreamModel: modelId,
      priority: 0,
      weight: 100,
      // No route_targets row stands behind a direct address, so there is
      // nothing that could have configured a service tier or set up a circuit
      // breaker for it. The flavor comes from the catalog row itself.
      serviceTier: null,
      apiFlavor: row.catalog.apiFlavor ?? row.provider.apiFlavor,
      breakable: false,
      breakerThreshold: null,
      breakerCooldownSeconds: null,
    }],
  }
}
