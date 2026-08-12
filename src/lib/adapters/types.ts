import type OpenAI from 'openai'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion
export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk

export interface ProviderConfig {
  /** Skip sending stream_options.include_usage — some clones reject it. */
  disableStreamUsage?: boolean
  /** Per-request upstream timeout in milliseconds. Defaults to 120_000. */
  timeoutMs?: number
  [key: string]: unknown
}

export interface ProviderRuntime {
  id: string
  name: string
  adapter: 'openai' | 'openai_compatible' | 'gemini' | 'bedrock'
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

export interface ProviderAdapter {
  chat(req: ChatCompletionRequest, ctx: AttemptContext): Promise<ChatCompletion>
  chatStream(
    req: ChatCompletionRequest,
    ctx: AttemptContext,
  ): AsyncIterable<ChatCompletionChunk>
}
