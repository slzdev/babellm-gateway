import type OpenAI from 'openai'
import type { DecisionsRequest, DecisionsResult } from '@/lib/schemas/decisions'
import type { AttemptContext, ProviderAdapter, ProviderRuntime } from '../types'
import { createOpenAIClient, type OpenAIClientFactory } from './client'
import { resolveRequestPaths } from '../paths'
import { toProviderError } from './errors'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import type { DecisionsApiFlavor } from '@/lib/decisions-api-flavors'

const PATH_HINT = 'If this provider serves decisions from another path, set its decisions path — or this one model\'s, on the Catalog page. A provider with no Decisions endpoint cannot answer this request.'

/** Native Decisions transport; keep the upstream result and its extensions intact. */
export async function decide(
  client: OpenAI,
  req: DecisionsRequest,
  ctx: AttemptContext,
  path: string,
): Promise<DecisionsResult> {
  try {
    return await client.post<DecisionsResult>(path, {
      body: { ...req, model: ctx.upstreamModel },
      signal: ctx.signal,
    })
  } catch (err) {
    throw toProviderError(err, PATH_HINT)
  }
}

/** Composable Decisions-only operation, selected by the independent request shape. */
export function createDecisionsOperation(
  runtime: ProviderRuntime,
  flavor: DecisionsApiFlavor,
  factory?: OpenAIClientFactory,
): Pick<ProviderAdapter, 'decide'> {
  switch (flavor) {
    case 'openai': {
      const client = createOpenAIClient(runtime, factory)
      const paths = resolveRequestPaths(runtime.config, runtime.baseUrl)
      return { decide: (req, ctx) => decide(client, req, ctx, paths.decisions) }
    }
    default:
      throw new UnsupportedOperationError(`Unsupported Decisions API flavor: ${flavor}`)
  }
}
