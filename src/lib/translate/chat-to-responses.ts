import type OpenAI from 'openai'
import type { ProviderConfig } from '@/lib/adapters/types'
import type { ChatCompletionRequest, ChatMessage } from '@/lib/schemas/chat'

type ResponseCreateParams = OpenAI.Responses.ResponseCreateParams
type ResponseInputItem = OpenAI.Responses.ResponseInputItem

/**
 * Chat Completions parameters the Responses API cannot express. They are
 * dropped rather than rejected: SDKs and frameworks routinely send
 * `frequency_penalty: 0` meaning nothing by it, and 400ing on those would make
 * the gateway unusable against a Responses provider without per-client config.
 */
const UNMAPPABLE = [
  'n',
  'stop',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'frequency_penalty',
  'presence_penalty',
  'seed',
] as const

/**
 * Values that mean "the default", which is also what the Responses API does.
 * Reporting them would put a line in the header on nearly every request and
 * bury `n: 3` and `stop`, the two cases where dropping changes the answer.
 */
const INERT: Record<string, unknown> = {
  n: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
}

function hasAudioPart(req: ChatCompletionRequest): boolean {
  return req.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'input_audio'),
  )
}

export function droppedParams(req: ChatCompletionRequest): string[] {
  const dropped: string[] = []

  for (const name of UNMAPPABLE) {
    const value = (req as Record<string, unknown>)[name]
    if (value === undefined || value === null) continue
    if (name in INERT && value === INERT[name]) continue
    dropped.push(name)
  }

  if (hasAudioPart(req)) dropped.push('audio_content')
  return dropped
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
}

function inputContent(content: ChatMessage['content']) {
  if (typeof content === 'string') return content
  if (!content) return ''

  const parts = []
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'input_text' as const, text: (part as { text: string }).text })
    } else if (part.type === 'image_url') {
      const image = (part as { image_url: { url: string; detail?: string } }).image_url
      parts.push({
        type: 'input_image' as const,
        image_url: image.url,
        detail: (image.detail ?? 'auto') as 'auto' | 'low' | 'high',
      })
    }
    // Audio and any other part type has no Responses equivalent. droppedParams
    // reports it; failing the request here would contradict the compatibility
    // decision the whole module is built on.
  }
  return parts
}

function toInput(messages: ChatMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = []

  for (const message of messages) {
    if (message.role === 'tool' || message.role === 'function') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: textOf(message.content),
      } as ResponseInputItem)
      continue
    }

    if (message.role === 'assistant') {
      const text = textOf(message.content)
      if (text.length > 0) {
        input.push({ role: 'assistant', content: text } as ResponseInputItem)
      }
      for (const call of message.tool_calls ?? []) {
        // The client's tool call id travels as call_id and must return
        // unchanged, or a tool loop breaks silently on its second turn.
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        } as ResponseInputItem)
      }
      continue
    }

    // EasyInputMessage accepts user, system and developer alike, so system
    // turns stay where the client put them. Hoisting them into `instructions`
    // would reorder a conversation that interleaves them.
    input.push({
      role: message.role,
      content: inputContent(message.content),
    } as ResponseInputItem)
  }

  return input
}

function toTools(tools: ChatCompletionRequest['tools']) {
  return tools?.map((tool) => ({
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: (tool.function.parameters ?? {}) as Record<string, unknown>,
    strict: tool.function.strict ?? null,
  }))
}

function toToolChoice(choice: ChatCompletionRequest['tool_choice']) {
  if (choice === undefined) return undefined
  if (typeof choice === 'string') return choice
  return { type: 'function' as const, name: choice.function.name }
}

function toText(format: ChatCompletionRequest['response_format']) {
  if (!format) return undefined

  if (format.type === 'json_schema') {
    const schema = (format as {
      json_schema?: { name?: string; schema?: unknown; strict?: boolean | null }
    }).json_schema
    return {
      format: {
        type: 'json_schema' as const,
        name: schema?.name ?? 'response',
        schema: (schema?.schema ?? {}) as Record<string, unknown>,
        strict: schema?.strict ?? null,
      },
    }
  }

  return { format: { type: format.type as 'text' | 'json_object' } }
}

function maxOutputTokens(req: ChatCompletionRequest): number | undefined {
  return req.max_completion_tokens ?? req.max_tokens ?? undefined
}

export function toResponsesRequest(
  req: ChatCompletionRequest,
  upstreamModel: string,
  config: ProviderConfig = {},
): ResponseCreateParams {
  const effort = (req as { reasoning_effort?: string | null }).reasoning_effort
  const maxTokens = maxOutputTokens(req)

  return {
    model: upstreamModel,
    input: toInput(req.messages),
    // Pinned rather than defaulted: the gateway is stateless by design, and a
    // provider quietly storing conversations would change that without anyone
    // choosing it.
    store: false,
    ...(maxTokens === undefined ? {} : { max_output_tokens: maxTokens }),
    ...(req.temperature == null ? {} : { temperature: req.temperature }),
    ...(req.top_p == null ? {} : { top_p: req.top_p }),
    ...(req.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: req.parallel_tool_calls }),
    ...(req.tools ? { tools: toTools(req.tools) } : {}),
    ...(req.tool_choice === undefined ? {} : { tool_choice: toToolChoice(req.tool_choice) }),
    ...(req.response_format ? { text: toText(req.response_format) } : {}),
    ...(req.user ? { safety_identifier: req.user } : {}),
    // Sending `reasoning` to a model that does not reason is an error upstream,
    // and the gateway cannot tell which kind it is addressing. So summaries are
    // requested only when the client's own request proves it expects one, or
    // when an admin has said so for this provider.
    ...(effort || config.requestReasoningSummary
      ? { reasoning: { ...(effort ? { effort } : {}), summary: 'auto' } }
      : {}),
  } as ResponseCreateParams
}
