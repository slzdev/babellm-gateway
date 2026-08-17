import { randomUUID } from 'node:crypto'
import type { ChatCompletion, ResponsesResult } from '@/lib/adapters/types'
import { ProviderError } from '@/lib/gateway/errors'
import type { ChatCompletionRequest, ChatMessage } from '@/lib/schemas/chat'
import type { ResponsesRequest } from '@/lib/schemas/responses'

/**
 * The other half of the round trip `chat-to-responses.ts` holds: this module
 * translates a Responses request into Chat Completions, for the case where a
 * Responses-shaped call lands on a chat-only provider, and translates the
 * chat-only provider's completion back into the Response shape the client
 * asked for. The stream half is a later task, mirroring how the sibling
 * module grew.
 *
 * Pure — no client, no I/O — so it tests as plain functions.
 */

type InputItem = Exclude<ResponsesRequest['input'], string>[number]
type Tool = NonNullable<ResponsesRequest['tools']>[number]
type ToolChoice = NonNullable<ResponsesRequest['tool_choice']>

const KNOWN_CONTENT_PART_TYPES = new Set(['input_text', 'input_image', 'output_text'])

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/**
 * Walks the input array looking for items and content parts this gateway
 * cannot express in Chat Completions. Kept separate from the message builder
 * below so each stays small, at the cost of re-checking each item's type —
 * the array is short and this only runs once per request.
 */
function inputDroppedKeys(input: ResponsesRequest['input']): string[] {
  if (typeof input === 'string') return []

  const dropped = new Set<string>()

  for (const item of input as InputItem[]) {
    if (item.type === 'message') {
      const content = (item as { content: unknown }).content
      if (Array.isArray(content)) {
        for (const part of content as { type: string }[]) {
          if (!KNOWN_CONTENT_PART_TYPES.has(part.type)) dropped.add(`input.${part.type}`)
        }
      }
      continue
    }

    if (item.type === 'function_call' || item.type === 'function_call_output') continue

    // `reasoning` is provider-internal working state, never meant to be fed
    // back as a turn. `item_reference` points at server-stored state, which
    // this gateway never creates (`store` is pinned false on the other
    // translation path) so it can never resolve one. Anything else here is a
    // shape this gateway has not been taught (the catch-all member of the
    // schema's inputItem union, see the comment there). All three have
    // nothing Chat Completions can represent.
    dropped.add(`input.${item.type}`)
  }

  return [...dropped]
}

export function droppedParams(req: ResponsesRequest): string[] {
  const dropped = new Set<string>()

  // `disabled` is the Responses API default and matches what Chat Completions
  // does anyway (no truncation control at all); only `auto` changes behavior.
  if (!isEmpty(req.truncation) && req.truncation !== 'disabled') dropped.add('truncation')
  if (!isEmpty(req.include)) dropped.add('include')
  // Only `store: true` changes anything — chat never persists a conversation
  // either way, so `false` (and omission) is what it does regardless.
  if (req.store === true) dropped.add('store')
  if (!isEmpty(req.metadata)) dropped.add('metadata')
  if (!isEmpty(req.max_tool_calls)) dropped.add('max_tool_calls')
  if (!isEmpty(req.prompt_cache_key)) dropped.add('prompt_cache_key')
  // Distinct from `user`, which maps directly below — safety_identifier has
  // no Chat Completions counterpart of its own.
  if (!isEmpty(req.safety_identifier)) dropped.add('safety_identifier')
  // Both name server-stored state; this gateway never creates any (`store` is
  // pinned false on the chat-to-responses path), so neither can be honored.
  if (!isEmpty(req.previous_response_id)) dropped.add('previous_response_id')
  if (!isEmpty(req.conversation)) dropped.add('conversation')
  if (req.reasoning && !isEmpty(req.reasoning.summary)) dropped.add('reasoning.summary')

  if (req.tool_choice && typeof req.tool_choice === 'object') {
    const choice = req.tool_choice as { type: string; name?: string }
    if (choice.type !== 'function' || !choice.name) dropped.add('tool_choice')
  }

  for (const key of inputDroppedKeys(req.input)) dropped.add(key)

  return [...dropped].sort()
}

/**
 * Assistant content collapses to a plain string (chat's own assistant
 * messages are always plain text), while user/system/developer content stays
 * a structured array — it can genuinely be multi-modal. A content part this
 * gateway does not recognise is skipped here; inputDroppedKeys reports it.
 */
function toMessageContent(
  role: string,
  content: string | { type: string; [key: string]: unknown }[],
): ChatMessage['content'] {
  if (typeof content === 'string') return content

  if (role === 'assistant') {
    return content
      .filter((part) => part.type === 'output_text')
      .map((part) => (part as unknown as { text: string }).text)
      .join('')
  }

  const parts: NonNullable<Exclude<ChatMessage['content'], string>> = []
  for (const part of content) {
    if (part.type === 'input_text') {
      parts.push({ type: 'text', text: (part as unknown as { text: string }).text })
    } else if (part.type === 'input_image') {
      const url = (part as unknown as { image_url?: string }).image_url
      if (url) parts.push({ type: 'image_url', image_url: { url } })
    }
    // Any other content part (input_audio, input_file, ...) has no Chat
    // Completions equivalent and is silently skipped here; the caller-facing
    // report comes from inputDroppedKeys, not from this function.
  }
  return parts
}

function toTools(tools: Tool[]) {
  return tools
    // Chat Completions can express only function tools; a hosted tool
    // (web_search, file_search, ...) has no `name` to un-nest and mapping it
    // anyway would emit `function: {name: undefined}`, which fails Chat's own
    // schema. This is belt to assertServiceable's braces, not a policy
    // decision of its own — that check runs before this module does and
    // already refuses the request for any non-function tool, so nothing here
    // is meant to be reachable in production. A pure function still must
    // never emit a structurally invalid value for whatever a caller hands it.
    .filter((tool) => (tool as { type: string }).type === 'function')
    .map((tool) => {
      const t = tool as unknown as {
        name: string
        description?: string
        parameters?: Record<string, unknown>
        strict?: boolean | null
      }
      return {
        type: 'function' as const,
        function: {
          name: t.name,
          ...(t.description === undefined ? {} : { description: t.description }),
          ...(t.parameters === undefined ? {} : { parameters: t.parameters }),
          ...(t.strict === undefined ? {} : { strict: t.strict }),
        },
      }
    })
}

function toToolChoice(choice: ToolChoice): ChatCompletionRequest['tool_choice'] {
  if (typeof choice === 'string') return choice
  const c = choice as { type: string; name?: string }
  // A hosted-tool choice (file_search, web_search, ...) has no Chat
  // Completions shape to un-nest into; droppedParams reports `tool_choice`
  // and the field is left off the translated request rather than sending
  // something the schema would reject.
  if (c.type !== 'function' || !c.name) return undefined
  return { type: 'function', function: { name: c.name } }
}

function toResponseFormat(text: ResponsesRequest['text']): ChatCompletionRequest['response_format'] {
  const format = text?.format
  if (!format) return undefined
  // `text` is the Responses default and is also what Chat Completions does
  // when response_format is left unset — nothing to carry over.
  if (format.type === 'text') return undefined

  if (format.type === 'json_schema') {
    const f = format as { name?: string; schema?: unknown; strict?: boolean | null }
    return {
      type: 'json_schema',
      json_schema: {
        name: f.name ?? 'response',
        schema: (f.schema ?? {}) as Record<string, unknown>,
        strict: f.strict ?? null,
      },
    } as ChatCompletionRequest['response_format']
  }

  // e.g. json_object: same name in both APIs, forwarded as-is.
  return { type: format.type } as ChatCompletionRequest['response_format']
}

/**
 * Builds the message list from `input`. Consecutive `function_call` items
 * collapse onto one assistant message's `tool_calls` array — Chat
 * Completions represents a parallel call that way, and leaving them as
 * separate messages would read as sequential turns instead of one.
 */
function toMessages(input: ResponsesRequest['input']): ChatMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }]

  const messages: ChatMessage[] = []
  let lastWasFunctionCall = false

  for (const item of input as InputItem[]) {
    if (item.type === 'message') {
      const m = item as { role: ChatMessage['role']; content: string | { type: string }[] }
      messages.push({ role: m.role, content: toMessageContent(m.role, m.content) })
      lastWasFunctionCall = false
      continue
    }

    if (item.type === 'function_call') {
      const call = item as { call_id: string; name: string; arguments: string }
      const toolCall = { id: call.call_id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } }

      if (lastWasFunctionCall) {
        const last = messages[messages.length - 1]
        last.tool_calls!.push(toolCall)
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] })
      }
      lastWasFunctionCall = true
      continue
    }

    if (item.type === 'function_call_output') {
      const out = item as { call_id: string; output: string }
      messages.push({ role: 'tool', tool_call_id: out.call_id, content: out.output })
      lastWasFunctionCall = false
      continue
    }

    // reasoning, item_reference, or an item type this gateway does not
    // recognise: no Chat Completions representation. droppedParams reports
    // it; there is nothing safe to feed back to the model as a turn.
    lastWasFunctionCall = false
  }

  return messages
}

/**
 * The rejections, as opposed to the drops.
 *
 * droppedParams covers parameters that shade the answer — the request still
 * gets a right-shaped response, just missing an extra or two. These change
 * it: a request asking for `web_search` against a provider that cannot
 * search is answered wrongly in a way that looks right, which is the one
 * failure mode the "drop and report" rule cannot cover. So it is refused
 * outright rather than silently degraded.
 *
 * The tool check is inverted on purpose: reject anything that is not
 * `type: 'function'`, rather than denying a fixed list of hosted-tool names.
 * Chat Completions can express exactly one kind of tool, so this is total —
 * a hosted tool OpenAI ships next month is caught by the same rule without
 * this file being touched again. A deny-list would let it through to
 * `toTools`, which silently drops anything it doesn't recognise.
 *
 * Non-retryable on purpose, twice over: it stops the chain rather than
 * replaying a request every target would refuse, and — because `execute`
 * only reports health for retryable failures — it cannot open a circuit
 * breaker on a target that is perfectly healthy.
 *
 * `background` is NOT checked here: it is refused for every target
 * regardless of API flavor, so the ingress schema rejects it at parse time
 * instead of every translation path re-checking it.
 */
export function assertServiceable(req: ResponsesRequest, provider: string): void {
  const nonFunction = req.tools?.find((tool) => tool.type !== 'function')
  if (nonFunction) {
    throw refuse(
      `The \`${nonFunction.type}\` tool is not available on provider "${provider}", which serves the Chat Completions API. Route this model to a target whose API flavor is "responses".`,
    )
  }

  for (const field of ['previous_response_id', 'conversation'] as const) {
    if (req[field] != null) {
      throw refuse(
        `\`${field}\` is not supported on provider "${provider}", which serves the Chat Completions API and holds no conversation state. Send the full input, or route this model to a target whose API flavor is "responses".`,
      )
    }
  }

  if (Array.isArray(req.input) && req.input.some((item) => item.type === 'item_reference')) {
    throw refuse(
      `An \`item_reference\` input item cannot be resolved on provider "${provider}", which serves the Chat Completions API and holds no conversation state.`,
    )
  }
}

function refuse(message: string): ProviderError {
  return new ProviderError({ status: 400, message, code: 'unsupported_parameter', retryable: false })
}

export function toChatRequest(req: ResponsesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = []
  if (req.instructions) messages.push({ role: 'system', content: req.instructions })
  messages.push(...toMessages(req.input))

  const effort = req.reasoning?.effort
  const responseFormat = toResponseFormat(req.text)
  const toolChoice = req.tool_choice === undefined ? undefined : toToolChoice(req.tool_choice)

  return {
    model: req.model,
    messages,
    ...(req.stream === undefined ? {} : { stream: req.stream }),
    ...(req.tools ? { tools: toTools(req.tools) } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(req.parallel_tool_calls == null ? {} : { parallel_tool_calls: req.parallel_tool_calls }),
    ...(req.max_output_tokens == null ? {} : { max_completion_tokens: req.max_output_tokens }),
    ...(req.temperature == null ? {} : { temperature: req.temperature }),
    ...(req.top_p == null ? {} : { top_p: req.top_p }),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(req.service_tier ? { service_tier: req.service_tier } : {}),
    ...(req.user ? { user: req.user } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  } as ChatCompletionRequest
}

type OutputItem = ResponsesResult['output'][number]

/**
 * `reasoning_content` is not part of Chat Completions' own schema — it is the
 * de facto convention DeepSeek, vLLM and OpenRouter use, and the one this
 * gateway's own `fromResponse` (chat-to-responses.ts) writes on the way out —
 * so a completion that carries it needs a cast to read it back.
 */
type ChatMessageWithReasoning = ChatCompletion['choices'][number]['message'] & {
  reasoning_content?: string
}

/**
 * `finish_reason` doubles as both the response-level status and, applied
 * uniformly, the status of every item in `output` — the same convention
 * `captureResponse` (gateway/protocols/responses.ts) uses for its own
 * synthesized message item. `tool_calls` falls through to `completed`
 * deliberately: a tool call is a finished turn, not a truncated one.
 */
function statusOf(
  finishReason: string,
): { status: 'completed' | 'incomplete'; incompleteDetails: NonNullable<ResponsesResult['incomplete_details']> | null } {
  if (finishReason === 'length') {
    return { status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } }
  }
  if (finishReason === 'content_filter') {
    return { status: 'incomplete', incompleteDetails: { reason: 'content_filter' } }
  }
  return { status: 'completed', incompleteDetails: null }
}

/**
 * Expands one Chat message into the ordered items a Response's flat `output`
 * array carries: reasoning first (it precedes the answer it led to), then the
 * message (only when there is content or a refusal to show — a bare tool
 * call has neither), then one function_call per tool call. Ids are minted
 * here since a Chat Completion never carries per-item ids of its own.
 */
function toOutput(message: ChatMessageWithReasoning, itemStatus: 'completed' | 'incomplete'): OutputItem[] {
  const output: OutputItem[] = []

  if (message.reasoning_content) {
    output.push({
      id: `rs_${randomUUID()}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
      status: itemStatus,
    } as unknown as OutputItem)
  }

  const content: { type: string; [key: string]: unknown }[] = []
  if (message.content) content.push({ type: 'output_text', text: message.content, annotations: [] })
  if (message.refusal) content.push({ type: 'refusal', refusal: message.refusal })
  if (content.length > 0) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      status: itemStatus,
      content,
    } as unknown as OutputItem)
  }

  // Only a function tool call has a `.function` to read a name/arguments
  // from — the same restriction assertServiceable enforces on the way in, so
  // a custom tool call can never reach a Chat Completions provider as a call
  // for it to answer with in the first place.
  const toolCalls = (message.tool_calls ?? []) as unknown as {
    id: string
    function: { name: string; arguments: string }
  }[]
  for (const call of toolCalls) {
    output.push({
      id: `fc_${randomUUID()}`,
      type: 'function_call',
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: itemStatus,
    } as unknown as OutputItem)
  }

  return output
}

/**
 * The inverse of `usageFromResponses` (gateway/usage.ts): Chat's
 * `prompt_tokens`/`completion_tokens` restated under the Responses spelling
 * `input_tokens`/`output_tokens`. Undefined when the completion carries no
 * usage at all — a fabricated all-zero object would read as "this cost
 * nothing" rather than "the provider did not say".
 */
function toUsage(usage: ChatCompletion['usage']): ResponsesResult['usage'] | undefined {
  if (!usage) return undefined
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.prompt_tokens_details
      ? { input_tokens_details: { cached_tokens: usage.prompt_tokens_details.cached_tokens } }
      : {}),
    ...(usage.completion_tokens_details
      ? { output_tokens_details: { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens } }
      : {}),
  } as ResponsesResult['usage']
}

/**
 * Translates a chat-only provider's completion back into the Response shape
 * the client asked for. `id` is minted by the caller (`newResponseId()`),
 * never here — this path has no upstream Responses id to preserve, since the
 * target is a stateless chat provider. `model` comes from the completion, not
 * `req`: the gateway's own identity step overwrites it with the virtual model
 * name afterwards, and duplicating that here would be a second source of
 * truth.
 */
export function fromCompletion(res: ChatCompletion, req: ResponsesRequest, id: string): ResponsesResult {
  const choice = res.choices[0]
  const message = choice.message as ChatMessageWithReasoning
  const { status, incompleteDetails } = statusOf(choice.finish_reason)

  return {
    id,
    object: 'response',
    created_at: res.created,
    model: res.model,
    status,
    incomplete_details: incompleteDetails,
    output: toOutput(message, status),
    ...(res.usage ? { usage: toUsage(res.usage) } : {}),
    // Echoed from the request: the real API returns them on the response
    // object, and the request is in hand, so mirroring it costs nothing and
    // improves client fidelity.
    instructions: req.instructions ?? null,
    tools: req.tools ?? [],
    ...(req.tool_choice === undefined ? {} : { tool_choice: req.tool_choice }),
    temperature: req.temperature ?? null,
    top_p: req.top_p ?? null,
    ...(req.text === undefined ? {} : { text: req.text }),
    ...(req.reasoning === undefined ? {} : { reasoning: req.reasoning }),
    ...(req.max_output_tokens == null ? {} : { max_output_tokens: req.max_output_tokens }),
    parallel_tool_calls: req.parallel_tool_calls ?? true,
    metadata: req.metadata ?? null,
    ...(req.user === undefined ? {} : { user: req.user }),
  } as unknown as ResponsesResult
}
