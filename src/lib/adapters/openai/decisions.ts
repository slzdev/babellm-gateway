import type OpenAI from 'openai'
import type { DecisionsRequest, DecisionsResult } from '@/lib/schemas/decisions'
import type { AttemptContext, ChatOnlyAdapter, ProviderAdapter, ProviderRuntime } from '../types'
import { createOpenAIClient, type OpenAIClientFactory } from './client'
import { resolveRequestPaths } from '../paths'
import { toProviderError } from './errors'

const PATH_HINT = 'If this provider serves decisions from another path, set its decisions path — or this one model\'s, on the Catalog page. A provider with no Decisions endpoint cannot answer this request.'

/** Decisions is a sibling API, independent of the model's chat flavor. */
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

/** The Anthropic chat flavor still reaches Decisions through an OpenAI client. */
export function withDecideViaOpenAI<A extends ChatOnlyAdapter>(
  adapter: A,
  runtime: ProviderRuntime,
  factory?: OpenAIClientFactory,
): A & Pick<ProviderAdapter, 'decide'> {
  const client = createOpenAIClient(runtime, factory)
  const path = resolveRequestPaths(runtime.config, runtime.baseUrl).decisions
  return { ...adapter, decide: (req, ctx) => decide(client, req, ctx, path) }
}
