import type OpenAI from 'openai'
import type { ChatCompletion, ChatCompletionChunk, ProviderConfig } from '@/lib/adapters/types'
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

/**
 * `stop: []`, `logprobs: false` and `logit_bias: {}` are just as inert as the
 * values in INERT above — frameworks send them unprompted — but they can't
 * live in a simple equality map because "empty" takes a different shape per
 * type. Checked structurally instead of growing INERT into something clever.
 */
function isInert(name: string, value: unknown): boolean {
  if (name in INERT && value === INERT[name]) return true
  if (value === false) return true
  if (Array.isArray(value) && value.length === 0) return true
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return true
  }
  return false
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
    if (isInert(name, value)) continue
    dropped.push(name)
  }

  if (hasAudioPart(req)) dropped.push('audio_content')

  if (req.messages.some((message) => message.role === 'function')) {
    dropped.push('legacy_function_message')
  }

  if (req.messages.some((message) => message.role === 'tool' && !message.tool_call_id)) {
    dropped.push('tool_message_without_call_id')
  }

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
    if (message.role === 'tool') {
      // `tool_call_id` is optional in the schema, so a valid request can omit
      // it. Without a call id there is nothing for a function_call_output to
      // correlate to, and emitting one with a fabricated id would send a
      // dangling reference upstream — the same defect the legacy `function`
      // branch below exists to avoid. Carry the result as data instead.
      if (!message.tool_call_id) {
        input.push({
          role: 'user',
          content: `[tool result] ${textOf(message.content)}`,
        } as ResponseInputItem)
        continue
      }

      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: textOf(message.content),
      } as ResponseInputItem)
      continue
    }

    // The deprecated functions API has no call id at all — a `function`
    // message carries only a name — so there is nothing for a
    // `function_call_output` to correlate to. Emitting one with a fabricated
    // id would send an item upstream referencing nothing, so the result is
    // carried as text instead: the model still sees what the function
    // returned, and droppedParams reports that the structure was lost. The
    // carrier is `user`, not `developer`: a function result is third-party
    // data — whatever an external API returned — and `developer` is the
    // high-authority instruction channel. Giving untrusted content that
    // authority would turn a prompt-injection payload into an instruction the
    // model is told to weigh heavily, which the Chat Completions original
    // never granted it.
    if (message.role === 'function') {
      input.push({
        role: 'user',
        content: `[function result: ${message.name ?? 'unknown'}] ${textOf(message.content)}`,
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

type ResponseItem = OpenAI.Responses.ResponseOutputItem
type ResponseUsage = OpenAI.Responses.ResponseUsage

function reasoningTextOf(item: OpenAI.Responses.ResponseReasoningItem): string {
  const summary = (item.summary ?? []).map((entry) => entry.text).join('')
  if (summary.length > 0) return summary
  // Some providers stream raw reasoning text and never populate a summary.
  return (item.content ?? []).map((entry) => entry.text).join('')
}

/**
 * Shared with the stream translator, which derives the same reason from the
 * response carried on the terminal event.
 */
function finishReason(
  res: { incomplete_details?: { reason?: string } | null },
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (hasToolCalls) return 'tool_calls'
  const reason = res.incomplete_details?.reason
  if (reason === 'max_output_tokens') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  return 'stop'
}

function toUsage(usage: ResponseUsage) {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    // `output_tokens_details` and `input_tokens_details` are non-optional in
    // ResponseUsage's types, which makes these guards look like dead code —
    // but this module exists to talk to minimal clones that omit them, so at
    // runtime the fields can genuinely be absent. Load-bearing; do not delete.
    ...(usage.output_tokens_details
      ? {
          completion_tokens_details: {
            reasoning_tokens: usage.output_tokens_details.reasoning_tokens,
          },
        }
      : {}),
    ...(usage.input_tokens_details
      ? { prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens } }
      : {}),
  }
}

export function fromResponse(res: OpenAI.Responses.Response): ChatCompletion {
  let content = ''
  let refusal = ''
  let reasoning = ''
  const toolCalls: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[] = []

  for (const item of (res.output ?? []) as ResponseItem[]) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') content += part.text
        else if (part.type === 'refusal') refusal += part.refusal
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      })
    } else if (item.type === 'reasoning') {
      reasoning += reasoningTextOf(item)
    }
    // Hosted-tool items — web_search_call, code_interpreter_call, mcp_call and
    // the rest — have no Chat Completions representation. They can only appear
    // if the provider injects tools server-side, since a Chat Completions
    // request cannot ask for them.
  }

  return {
    id: res.id,
    object: 'chat.completion',
    created: res.created_at,
    model: res.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        ...(refusal.length > 0 ? { refusal } : {}),
        // Non-standard, and deliberately so: it is the convention DeepSeek,
        // vLLM and OpenRouter already use, which is why real clients render it.
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason(res, toolCalls.length > 0),
      logprobs: null,
    }],
    ...(res.usage ? { usage: toUsage(res.usage) } : {}),
  } as ChatCompletion
}

type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent

/**
 * Chat Completions chunks are positional deltas; Responses events are semantic
 * and indexed by `output_index`, which counts every output item — reasoning and
 * messages included — while `tool_calls[].index` counts only tool calls. The
 * map between the two is the only state this translator keeps, alongside the
 * pending role.
 */
export async function* fromResponseStream(
  events: AsyncIterable<ResponseStreamEvent>,
  req: ChatCompletionRequest,
): AsyncIterable<ChatCompletionChunk> {
  const toolIndexByOutput = new Map<number, number>()
  let nextToolIndex = 0
  let rolePending = true
  // `identity.ts`'s rewriteChunk overwrites `id` and `model` on every chunk
  // but not `created` — it is the one metadata field left as this translator
  // sets it. A clone that omits `response.created` would otherwise leave
  // every chunk stamped with the epoch instead of a plausible timestamp.
  let created = Math.floor(Date.now() / 1000)
  let model = ''

  // Responses always reports usage on completion, so `include_usage` needs no
  // upstream parameter — only an opt-out honoured here.
  const includeUsage = req.stream_options?.include_usage !== false

  function chunk(
    delta: Record<string, unknown>,
    reason: string | null = null,
  ): ChatCompletionChunk {
    // The role rides the first chunk that carries real content rather than
    // being emitted on response.created, so the eager first-chunk pull in
    // startChatStream keeps meaning "the upstream produced something" — which
    // is what makes failover and ttftMs measure what they claim to.
    const withRole = rolePending ? { role: 'assistant', ...delta } : delta
    rolePending = false

    return {
      id: '',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: withRole, finish_reason: reason }],
    } as ChatCompletionChunk
  }

  for await (const event of events) {
    switch (event.type) {
      case 'response.created':
        // Emits nothing, but carries the metadata every chunk needs.
        created = event.response.created_at
        model = event.response.model
        break

      case 'response.output_text.delta':
        yield chunk({ content: event.delta })
        break

      case 'response.refusal.delta':
        yield chunk({ refusal: event.delta })
        break

      // Both arms concatenate onto the same field, but a buffered response
      // (reasoningTextOf, above) prefers the summary and falls back to raw
      // text only when no summary exists. A provider that streams both a
      // summary and raw reasoning text therefore doubles the content here in
      // a way the non-streaming path never would. There is no correct
      // streaming fix — the translator cannot know in advance whether a
      // summary is still coming — so this is recorded rather than patched.
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        yield chunk({ reasoning_content: event.delta })
        break

      case 'response.output_item.added': {
        if (event.item.type !== 'function_call') break
        const index = nextToolIndex++
        toolIndexByOutput.set(event.output_index, index)
        yield chunk({
          tool_calls: [{
            index,
            id: event.item.call_id,
            type: 'function',
            function: { name: event.item.name, arguments: '' },
          }],
        })
        break
      }

      case 'response.function_call_arguments.delta': {
        const index = toolIndexByOutput.get(event.output_index)
        // No `response.output_item.added` was seen for this output_index, so
        // there is no call_id/name to synthesise an opening fragment from —
        // dropping is the only option. The consequence: no tool_calls
        // fragment is ever emitted for this call, nextToolIndex stays at 0,
        // finishReason falls through to 'stop', and the client receives an
        // empty assistant message where a tool call was intended.
        if (index === undefined) break
        yield chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] })
        break
      }

      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response
        yield chunk({}, finishReason(response, nextToolIndex > 0))
        if (includeUsage && response.usage) {
          yield {
            id: '',
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: toUsage(response.usage),
          } as ChatCompletionChunk
        }
        break
      }

      case 'response.failed':
        throw new Error(
          event.response.error?.message ?? 'The upstream response failed.',
        )

      // `error` is a top-level stream event, not a response status — a clone
      // can emit it mid-stream instead of `response.failed`. Dropping it ends
      // the stream cleanly, so a truncated answer would reach the client as a
      // successful 200 and log as one.
      case 'error':
        throw new Error(event.message || 'The upstream stream reported an error.')

      default:
        // Everything else is deliberately dropped. The `.done` events restate
        // what the deltas already delivered, and emitting them would duplicate
        // every response; content_part.*, output_item.done,
        // reasoning_summary_part.*, annotations, queued/in_progress and the
        // hosted-tool progress events have no Chat Completions counterpart.
        break
    }
  }
}
