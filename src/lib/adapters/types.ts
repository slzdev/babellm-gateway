import type OpenAI from 'openai'
import type { AdapterType } from '@/lib/adapters/credentials'
import type { CatalogFields } from '@/lib/catalog/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type { EmbeddingsRequest } from '@/lib/schemas/embeddings'
import type { ResponsesRequest } from '@/lib/schemas/responses'
import type { TranscriptionRequest } from '@/lib/schemas/transcription'

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion
export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk
export type ResponsesResult = OpenAI.Responses.Response
export type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent
export type Transcription = OpenAI.Audio.Transcription
export type TranscriptionVerbose = OpenAI.Audio.TranscriptionVerbose
/**
 * The three shapes the upstream endpoint returns, discriminated by the
 * `response_format` the ingress already knows it asked for. No wrapper
 * object carrying the format alongside the body: a second copy of it here
 * could only ever disagree with the one the ingress already has.
 */
export type TranscriptionResult = Transcription | TranscriptionVerbose | string
// No streaming counterpart, and no union either: the embeddings API has one
// wire shape and no streaming form at all, which is why this is one type where
// the two above it are pairs and a triple.
export type EmbeddingsResult = OpenAI.Embeddings.CreateEmbeddingResponse

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
  audioTranscriptionsPath?: string
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
  audioTranscriptionsPath?: string | null
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
  /**
   * No streaming twin: section 3.7 of the design doc refuses `stream: true`
   * for this endpoint entirely, and a method whose only implementation
   * throws would put a lie in the interface.
   */
  transcribe(req: TranscriptionRequest, ctx: AttemptContext): Promise<TranscriptionResult>
  /**
   * Required for the same reason `transcribe` is, and supplied the same way:
   * `withEmbedUnsupported` gives it to the one flavor whose host has no
   * embeddings endpoint at all. An optional method would have made "cannot
   * embed" a fact only the ingress could see, and the ingress is the wrong
   * place for it — `supports` steers a mixed model away from such a target
   * before selection, but the request that reaches a model where *every*
   * target is one still has to be refused by whoever knows why.
   *
   * No streaming twin here either, and for a stronger reason than
   * transcription's: the OpenAI embeddings API has no streaming form to
   * refuse.
   */
  embed(req: EmbeddingsRequest, ctx: AttemptContext): Promise<EmbeddingsResult>
}

/**
 * What `createGeminiAdapter` builds (and what `createOpenAIAdapter` builds
 * before it layers on its own native `transcribe` and `embed` — see
 * openai/audio.ts and openai/embeddings.ts): chat-native, with no opinion
 * about the Responses API, transcription, or embeddings.
 * `respond`/`respondStream` are supplied by `withRespondViaChat`,
 * `transcribe` by `withTranscribeUnsupported` and `embed` by
 * `withEmbedUnsupported`, all in wrappers.ts — the only places allowed to
 * know these methods are missing.
 */
export type ChatOnlyAdapter =
  Omit<ProviderAdapter, 'respond' | 'respondStream' | 'transcribe' | 'embed'>
