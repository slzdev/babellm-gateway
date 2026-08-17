import type { ChatCompletionRequest, ChatMessage } from '@/lib/schemas/chat'
import type { ResponsesRequest } from '@/lib/schemas/responses'

/**
 * The other half of the round trip `chat-to-responses.ts` holds: this module
 * translates a Responses request into Chat Completions, for the case where a
 * Responses-shaped call lands on a chat-only provider. Later tasks add the
 * result and stream halves to this same file, mirroring how the sibling
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
