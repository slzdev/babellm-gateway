import type OpenAI from 'openai'
import type { AdapterType } from '@/lib/adapters/credentials'
import type { CatalogFields } from '@/lib/catalog/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion
export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk

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
   * somewhere other than where the SDK looks for it. Each is joined onto the
   * base URL the same way the default is, so the base URL keeps carrying
   * whatever prefix (`/v1`) it carries today. Absent means the default —
   * see DEFAULT_PATHS in ./openai/paths.
   */
  modelsPath?: string
  chatCompletionsPath?: string
  responsesPath?: string
  [key: string]: unknown
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
}
