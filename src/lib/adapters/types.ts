import type OpenAI from 'openai'
import type { AdapterType } from '@/lib/adapters/credentials'
import type { CatalogFields } from '@/lib/catalog/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type { ResponsesRequest } from '@/lib/schemas/responses'

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion
export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk
export type ResponsesResult = OpenAI.Responses.Response
export type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent

export interface ProviderConfig {
  /** Skip sending stream_options.include_usage — some clones reject it. */
  disableStreamUsage?: boolean
  /** Per-request upstream timeout in milliseconds. Defaults to 120_000. */
  timeoutMs?: number
  /**
   * models.dev namespace this provider's models live under ("groq",
   * "openrouter"). Only meaningful for `openai_compatible`, whose endpoint
   * could be anything; without it those models stay unmatched in the catalog.
   */
  registryNamespace?: string
  /**
   * Ask the provider for reasoning summaries even when the client did not send
   * `reasoning_effort`. Off by default: requesting thoughts from a model that
   * does not reason is an error, and the gateway cannot tell which kind of
   * model it is addressing.
   */
  requestReasoningSummary?: boolean
  /**
   * Per-endpoint path overrides, for clones that hang the OpenAI shape off
   * somewhere other than where the SDK looks for it. Each names the whole path
   * on the base URL's host, replacing whatever prefix (`/v1`) the base URL
   * carries; only the default, meaning absent, is appended to the base URL as
   * it stands — see DEFAULT_PATHS and resolveRequestPaths in ./paths.
   */
  modelsPath?: string
  chatCompletionsPath?: string
  responsesPath?: string
  messagesPath?: string
  embeddingsPath?: string
  [key: string]: unknown
}

/**
 * What one model contributes to adapter construction. The keys are the
 * `ProviderConfig` keys deliberately: `createAdapter` folds these over the
 * provider's config, so the adapters go on reading one object and never learn
 * that a model can carry paths of its own.
 *
 * `null` means "this model names no path", which is not the same as "no path"
 * — it must leave the provider's value standing.
 */
export interface ModelPathOverrides {
  chatCompletionsPath?: string | null
  responsesPath?: string | null
  messagesPath?: string | null
  embeddingsPath?: string | null
}

export interface ProviderRuntime {
  id: string
  name: string
  adapter: AdapterType
  baseUrl: string | null
  credentials: Record<string, unknown>
  config: ProviderConfig
}

export interface AttemptContext {
  /** The provider's own model name, not the virtual one. */
  upstreamModel: string
  signal: AbortSignal
  requestId: string
}

/** One model a provider reports it can serve. */
export interface DiscoveredModel {
  id: string
  /**
   * Whatever the adapter could map onto catalog fields. Empty for every
   * OpenAI-shaped provider, whose /v1/models reports nothing but an id.
   */
  fields: CatalogFields
  /** The provider's raw entry, kept for debugging. */
  raw: unknown
}

export interface ListModelsContext {
  signal: AbortSignal
}

export interface ProviderAdapter {
  chat(req: ChatCompletionRequest, ctx: AttemptContext): Promise<ChatCompletion>
  chatStream(
    req: ChatCompletionRequest,
    ctx: AttemptContext,
  ): AsyncIterable<ChatCompletionChunk>
  /**
   * Optional: adapters that cannot enumerate models simply omit it, and the
   * sync reports `unsupported` rather than failing.
   */
  listModels?(ctx: ListModelsContext): Promise<DiscoveredModel[]>
  /**
   * Every adapter must be able to serve a Responses request: either
   * natively, or through `withRespondViaChat` (see adapters/wrappers.ts),
   * which every chat-only adapter is wrapped in at construction time.
   */
  respond(req: ResponsesRequest, ctx: AttemptContext): Promise<ResponsesResult>
  respondStream(
    req: ResponsesRequest,
    ctx: AttemptContext,
  ): AsyncIterable<ResponseStreamEvent>
}

/**
 * What `createOpenAIAdapter` and `createGeminiAdapter` build: chat-native,
 * with no opinion about the Responses API. Each is upgraded to a full
 * `ProviderAdapter` by `withRespondViaChat` in registry.ts, which is the only
 * place that is allowed to know these two methods are missing.
 */
export type ChatOnlyAdapter = Omit<ProviderAdapter, 'respond' | 'respondStream'>
