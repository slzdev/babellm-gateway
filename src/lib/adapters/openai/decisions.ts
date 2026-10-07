import type OpenAI from 'openai'
import type { DecisionsRequest, DecisionsResult } from '@/lib/schemas/decisions'
import type { AttemptContext, ProviderAdapter, ProviderRuntime } from '../types'
import { createOpenAIClient, listModels, type OpenAIClientFactory } from './client'
import { deriveEmbeddingsModelsPath, resolveRequestPaths } from '../paths'
import { toProviderError } from './errors'
import { UnsupportedOperationError } from '@/lib/gateway/errors'
import { embed } from './embeddings'
import { transcribeVia } from './audio'

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

/** The primary inference protocol for a Decisions-flavored OpenAI model. */
export function createDecisionsAdapter(
  runtime: ProviderRuntime,
  factory?: OpenAIClientFactory,
): ProviderAdapter {
  const client = createOpenAIClient(runtime, factory)
  const paths = resolveRequestPaths(runtime.config, runtime.baseUrl)
  const embeddingsModelsPath = runtime.adapter === 'openai_compatible'
    ? deriveEmbeddingsModelsPath(paths.models)
    : null
  const unsupported = () => new UnsupportedOperationError(
    `"${runtime.name}" uses Decisions API and cannot serve Chat Completions or Responses. Select a chat-capable API flavor on the provider or Catalog model to use those endpoints. Decisions answers are not translated into chat.`,
  )

  return {
    decide: (req, ctx) => decide(client, req, ctx, paths.decisions),
    async chat() { throw unsupported() },
    async *chatStream() { throw unsupported() },
    async respond() { throw unsupported() },
    async *respondStream() { throw unsupported() },
    listModels: (ctx) => listModels(client, ctx, paths.models, embeddingsModelsPath),
    embed: (req, ctx) => embed(client, req, ctx, paths.embeddings),
    transcribe: transcribeVia(client, paths.audioTranscriptions),
  }
}
