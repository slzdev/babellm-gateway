import { computeCost } from '@/lib/pricing'
import { decisionsRequestSchema, type DecisionsRequest, type DecisionsResult } from '@/lib/schemas/decisions'
import { withUsageCost } from '../cost'
import { parseWith, readJson, type Ingress } from '../handler'
import { usageFromResponses } from '../usage'

export const decisionsIngress: Ingress<DecisionsRequest, DecisionsResult, never> = {
  read: async (request) => parseWith(decisionsRequestSchema, await readJson(request)),
  modelOf: (req) => req.model,
  isStream: () => false,
  supports: (candidate) => candidate.provider.adapter === 'openai' || candidate.provider.adapter === 'openai_compatible',
  // The API has no service tier. A pinned tier is reported, never injected.
  droppedFor: (candidate) => candidate.serviceTier ? ['service_tier'] : [],
  run: (adapter, ctx, req) => adapter.decide(req, ctx),
  usageOf: (res) => usageFromResponses(res.usage),
  cost: computeCost,
  finish: (res, identity, cost) => withUsageCost({ ...res, model: identity.model }, cost),
  toResponse: (res, headers) => Response.json(res, { headers }),
}
