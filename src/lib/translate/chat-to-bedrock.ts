import { randomUUID } from 'node:crypto'
import type {
  ContentBlock, ConverseCommandInput, ConverseCommandOutput, ConverseStreamOutput,
  Message, TokenUsage, ToolChoice, ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime'
import type { ChatCompletion, ChatCompletionChunk } from '@/lib/adapters/types'
import { GatewayError, ProviderError } from '@/lib/gateway/errors'
import type { ChatCompletionRequest, ChatMessage } from '@/lib/schemas/chat'

type JsonDocument = NonNullable<ToolInputSchema['json']>

function clientError(message: string, param: string): GatewayError {
  return new GatewayError({ status: 400, type: 'invalid_request_error', code: 'invalid_value', message, param })
}

function upstreamError(message: string): ProviderError {
  return new ProviderError({ status: 502, code: 'malformed_upstream_response', message, retryable: true })
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return object(value) ? value : null
  } catch { return null }
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return (content ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
}

const IMAGE_FORMATS = new Map<string, 'png' | 'jpeg' | 'gif' | 'webp'>([
  ['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
])

/** No URL is dereferenced here. Bedrock SDK byte sources need decoded base64,
 * unlike the wire protocol's JSON encoding of the same image. */
function inlineImage(url: string, param: string): ContentBlock | null {
  if (!url.startsWith('data:')) return null
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url)
  if (!match) throw clientError('Image must be a base64 data URL.', param)
  const [, mime, encoded] = match
  const format = IMAGE_FORMATS.get(mime)
  if (!format) return null
  // Buffer.from is deliberately forgiving of garbage, so validate first and
  // compare canonical bytes afterward. Accept padded and unpadded base64.
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw clientError('Image contains invalid base64 bytes.', param)
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
    || (encoded.includes('=') && encoded.length % 4 !== 0)) {
    throw clientError('Image contains invalid base64 bytes.', param)
  }
  return { image: { format, source: { bytes: new Uint8Array(bytes) } } }
}

function toolId(message: ChatMessage, calls: Map<string, string>): string | undefined {
  if (message.tool_call_id && calls.has(message.tool_call_id)) return message.tool_call_id
  // The deprecated function role identifies the call by name. Use the most
  // recent matching assistant call, never synthesize an unrelated reference.
  if (message.role === 'function' && !message.tool_call_id && message.name) {
    return [...calls].reverse().find(([, name]) => name === message.name)?.[0]
  }
}

function toolChoice(choice: ChatCompletionRequest['tool_choice']): ToolChoice | undefined {
  if (choice === 'auto') return { auto: {} }
  if (choice === 'required') return { any: {} }
  if (choice && choice !== 'none') return { tool: { name: choice.function.name } }
}

function toolsEnabled(req: ChatCompletionRequest): boolean {
  return !!req.tools?.length && req.tool_choice !== 'none'
}

export function toConverseRequest(req: ChatCompletionRequest, upstreamModel: string): ConverseCommandInput {
  const nativeTools = toolsEnabled(req)
  const messages: Message[] = []
  const system: { text: string }[] = []
  const calls = new Map<string, string>()
  function append(role: 'user' | 'assistant', content: ContentBlock[]) {
    if (!content.length) return
    const last = messages.at(-1)
    if (last?.role === role) last.content!.push(...content)
    else messages.push({ role, content })
  }

  req.messages.forEach((message, mi) => {
    const text = textOf(message.content)
    if (message.role === 'system' || message.role === 'developer') {
      if (text) system.push({ text })
      return
    }
    if (message.role === 'tool' || message.role === 'function') {
      const id = toolId(message, calls)
      // Native history requires toolConfig, which cannot express a prohibition
      // on new calls. Preserve disabled tools as labeled historical data.
      append('user', [!nativeTools
        ? { text: `[historical tool result] ${JSON.stringify({ id: id ?? message.tool_call_id, name: id ? calls.get(id) : message.name, output: text })}` }
        : id
          ? { toolResult: { toolUseId: id, content: [text ? { text } : { json: { output: '' } }] } }
          : { text: `[tool result] ${text}` }])
      if (id) calls.delete(id)
      return
    }
    const blocks: ContentBlock[] = []
    if (message.role === 'assistant') {
      if (text) blocks.push({ text })
      for (const [ci, call] of (message.tool_calls ?? []).entries()) {
        const input = parseArguments(call.function.arguments)
        if (!input) throw clientError('Tool arguments must be a valid JSON object.', `messages[${mi}].tool_calls[${ci}].function.arguments`)
        blocks.push(nativeTools
          ? { toolUse: { toolUseId: call.id, name: call.function.name, input: input as JsonDocument } }
          : { text: `[historical tool call] ${JSON.stringify({ id: call.id, name: call.function.name, arguments: input })}` })
        calls.set(call.id, call.function.name)
      }
    } else if (typeof message.content === 'string') {
      if (message.content) blocks.push({ text: message.content })
    } else {
      for (const [pi, part] of (message.content ?? []).entries()) {
        if (part.type === 'text') {
          if (typeof part.text === 'string' && part.text) blocks.push({ text: part.text })
        } else if (part.type === 'image_url') {
          const url = (part as { image_url?: { url?: unknown } }).image_url?.url
          if (typeof url !== 'string') continue
          const image = inlineImage(url, `messages[${mi}].content[${pi}].image_url.url`)
          if (image) blocks.push(image)
        }
      }
    }
    append(message.role, blocks)
  })

  const maxTokens = req.max_completion_tokens ?? req.max_tokens
  const stop = (Array.isArray(req.stop) ? req.stop : req.stop == null ? [] : [req.stop]).filter(Boolean)
  const inferenceConfig = {
    ...(maxTokens == null ? {} : { maxTokens }),
    ...(req.temperature == null ? {} : { temperature: req.temperature }),
    ...(req.top_p == null ? {} : { topP: req.top_p }),
    ...(stop.length ? { stopSequences: stop } : {}),
  }
  const choice = toolChoice(req.tool_choice)
  return {
    modelId: upstreamModel, messages,
    ...(system.length ? { system } : {}),
    ...(Object.keys(inferenceConfig).length ? { inferenceConfig } : {}),
    ...(nativeTools ? { toolConfig: {
      tools: req.tools!.map((tool) => ({ toolSpec: {
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        inputSchema: { json: (tool.function.parameters ?? { type: 'object' }) as JsonDocument },
      } })),
      ...(choice ? { toolChoice: choice } : {}),
    } } : {}),
  }
}

function finishReason(reason: string | undefined, hasTools: boolean): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  switch (reason) {
    case 'max_tokens': case 'model_context_window_exceeded': return 'length'
    case 'guardrail_intervened': case 'content_filtered': return 'content_filter'
    case 'tool_use':
      if (!hasTools) throw upstreamError('Bedrock stopped for tool use without returning a tool call.')
      return 'tool_calls'
    case 'end_turn': case 'stop_sequence': return hasTools ? 'tool_calls' : 'stop'
    default: throw upstreamError(`Bedrock returned an invalid stop reason: ${reason ?? 'missing'}.`)
  }
}

function usageOf(usage: TokenUsage | undefined): ChatCompletion['usage'] {
  // Absent required measurements are unknown, not zero. Cache counters are
  // optional in AWS and their absence means this response reports no caching.
  if (!usage || ![usage.inputTokens, usage.outputTokens].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return undefined
  const cached = usage.cacheReadInputTokens ?? 0
  const written = usage.cacheWriteInputTokens ?? 0
  if (![cached, written].every((n) => Number.isFinite(n) && n >= 0)) return undefined
  const prompt = usage.inputTokens! + cached + written
  const completion = usage.outputTokens!
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}) }
}

export function fromConverse(result: ConverseCommandOutput, upstreamModel: string): ChatCompletion {
  const message = result.output?.message
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) throw upstreamError('Bedrock returned no assistant message.')
  let text = ''
  let reasoning = ''
  const tools: NonNullable<ChatCompletion['choices'][number]['message']['tool_calls']> = []
  for (const block of message.content) {
    if (!object(block)) throw upstreamError('Bedrock returned a malformed content block.')
    if (typeof block.text === 'string') text += block.text
    else if (block.reasoningContent) {
      const value = block.reasoningContent.reasoningText?.text
      if (typeof value === 'string') reasoning += value
      else if (!block.reasoningContent.redactedContent) throw upstreamError('Bedrock returned malformed reasoning content.')
    } else if (block.toolUse) {
      const { toolUseId, name, input } = block.toolUse
      if (!toolUseId || !name || !object(input)) throw upstreamError('Bedrock returned a malformed tool call.')
      tools.push({ id: toolUseId, type: 'function', function: { name, arguments: JSON.stringify(input) } })
    } else throw upstreamError('Bedrock returned unsupported or malformed message content.')
  }
  const usage = usageOf(result.usage)
  return {
    id: `chatcmpl-${result.$metadata?.requestId ?? randomUUID()}`, object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model: upstreamModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.length ? { tool_calls: tools } : {}),
    }, finish_reason: finishReason(result.stopReason, tools.length > 0), logprobs: null }],
    ...(usage ? { usage } : {}),
  } as ChatCompletion
}

const STREAM_EXCEPTIONS = {
  internalServerException: { status: 500, retryable: true },
  modelStreamErrorException: { status: 424, retryable: true },
  serviceUnavailableException: { status: 503, retryable: true },
  throttlingException: { status: 429, retryable: true },
  validationException: { status: 400, retryable: false },
} as const

type StreamBlock = { kind: 'text' | 'reasoning'; closed: boolean } | { kind: 'tool'; closed: boolean; index: number; input: string }

export async function* fromConverseStream(
  stream: AsyncIterable<ConverseStreamOutput>, req: ChatCompletionRequest, upstreamModel: string,
): AsyncIterable<ChatCompletionChunk> {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const blocks = new Map<number, StreamBlock>()
  let started = false
  let stopped = false
  let nextToolIndex = 0
  let finish: ReturnType<typeof finishReason> | undefined
  let usage: ChatCompletion['usage']
  function chunk(delta: Record<string, unknown>, finish_reason: ReturnType<typeof finishReason> | null = null): ChatCompletionChunk {
    return { id, object: 'chat.completion.chunk', created, model: upstreamModel,
      choices: [{ index: 0, delta, finish_reason, logprobs: null }] } as ChatCompletionChunk
  }
  function blockIndex(index: number | undefined): number {
    if (index === undefined || !Number.isInteger(index) || index < 0) throw upstreamError('Bedrock stream has an invalid content block index.')
    return index
  }
  for await (const event of stream) {
    for (const [name, classification] of Object.entries(STREAM_EXCEPTIONS)) {
      const value = (event as unknown as Record<string, unknown>)[name]
      if (value) throw new ProviderError({ ...classification, code: name,
        message: object(value) && typeof value.message === 'string' ? value.message : `Bedrock stream failed: ${name}.` })
    }
    if (event.messageStart) {
      if (started || event.messageStart.role !== 'assistant') throw upstreamError('Bedrock stream has an invalid message start.')
      started = true
      yield chunk({ role: 'assistant' })
    } else if (event.metadata) {
      if (!stopped) throw upstreamError('Bedrock stream returned metadata before message stop.')
      usage = usageOf(event.metadata.usage)
    } else if (event.messageStop) {
      if (!started || stopped || [...blocks.values()].some((b) => !b.closed)) throw upstreamError('Bedrock stream stopped with incomplete content.')
      finish = finishReason(event.messageStop.stopReason, nextToolIndex > 0)
      stopped = true
    } else {
      if (!started || stopped) throw upstreamError('Bedrock stream returned content outside a message.')
      if (event.contentBlockStart) {
        const { start, contentBlockIndex } = event.contentBlockStart
        const index = blockIndex(contentBlockIndex)
        const tool = start?.toolUse
        if (blocks.has(index) || !tool?.toolUseId || !tool.name) throw upstreamError('Bedrock stream returned a malformed tool start.')
        const toolIndex = nextToolIndex++
        blocks.set(index, { kind: 'tool', closed: false, index: toolIndex, input: '' })
        yield chunk({ tool_calls: [{ index: toolIndex, id: tool.toolUseId, type: 'function', function: { name: tool.name, arguments: '' } }] })
      } else if (event.contentBlockDelta) {
        const { delta, contentBlockIndex } = event.contentBlockDelta
        const index = blockIndex(contentBlockIndex)
        const previous = blocks.get(index)
        if (previous?.closed) throw upstreamError('Bedrock stream returned a delta after content block stop.')
        if (delta?.toolUse) {
          if (previous?.kind !== 'tool' || typeof delta.toolUse.input !== 'string') throw upstreamError('Bedrock stream returned tool input without a tool start.')
          previous.input += delta.toolUse.input
          yield chunk({ tool_calls: [{ index: previous.index, function: { arguments: delta.toolUse.input } }] })
        } else if (typeof delta?.text === 'string') {
          if (previous && previous.kind !== 'text') throw upstreamError('Bedrock stream changed content block type.')
          blocks.set(index, { kind: 'text', closed: false })
          yield chunk({ content: delta.text })
        } else if (delta?.reasoningContent) {
          if (previous && previous.kind !== 'reasoning') throw upstreamError('Bedrock stream changed content block type.')
          blocks.set(index, { kind: 'reasoning', closed: false })
          if (typeof delta.reasoningContent.text === 'string') yield chunk({ reasoning_content: delta.reasoningContent.text })
          else if (!delta.reasoningContent.signature && !delta.reasoningContent.redactedContent) throw upstreamError('Bedrock stream returned malformed reasoning.')
        } else throw upstreamError('Bedrock stream returned unsupported or malformed content.')
      } else if (event.contentBlockStop) {
        const block = blocks.get(blockIndex(event.contentBlockStop.contentBlockIndex))
        if (!block || block.closed) throw upstreamError('Bedrock stream stopped an unknown content block.')
        if (block.kind === 'tool' && !parseArguments(block.input)) throw upstreamError('Bedrock stream returned malformed tool arguments.')
        block.closed = true
      } else throw upstreamError('Bedrock stream returned an unknown event.')
    }
  }
  if (!stopped || !finish) throw upstreamError('Bedrock stream ended before message stop.')
  // Do not announce successful termination until the stream has drained:
  // metadata and even exception events can follow messageStop.
  yield chunk({}, finish)
  if (req.stream_options?.include_usage !== false && usage) {
    yield { id, object: 'chat.completion.chunk', created, model: upstreamModel, choices: [], usage }
  }
}

const MAPPED = new Set([
  'model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice',
  'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop',
])
const INERT: Record<string, unknown> = { n: 1, logprobs: false, parallel_tool_calls: true }
function inert(name: string, value: unknown): boolean {
  return value == null || value === '' || (name in INERT && value === INERT[name])
    || (Array.isArray(value) && value.length === 0) || (object(value) && Object.keys(value).length === 0)
}

export function droppedParams(req: ChatCompletionRequest): string[] {
  const dropped = new Set<string>()
  for (const [name, value] of Object.entries(req)) {
    if (!MAPPED.has(name) && !inert(name, value)) dropped.add(name)
  }
  const calls = new Map<string, string>()
  const nativeTools = toolsEnabled(req)
  let sawTurn = false
  for (const message of req.messages) {
    if (!nativeTools && (message.tool_calls?.length || message.role === 'tool' || message.role === 'function')) dropped.add('tool_history')
    if (message.role === 'system' || message.role === 'developer') {
      if (sawTurn) dropped.add('system_message_hoisted')
    } else sawTurn = true
    if (message.role === 'tool' || message.role === 'function') {
      const id = toolId(message, calls)
      if (!id) dropped.add('unmatched_tool_call_id')
      else calls.delete(id)
    }
    for (const call of message.tool_calls ?? []) calls.set(call.id, call.function.name)
    for (const field of ['reasoning_content', 'reasoning', 'reasoning_details']) {
      if (!inert(field, message[field])) dropped.add(field)
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') continue
        const image = (part as { image_url?: { url?: unknown; detail?: unknown } }).image_url
        const url = image?.url
        const match = typeof url === 'string' ? /^data:([^;,]+);base64,/.exec(url) : null
        if (message.role !== 'user' || part.type !== 'image_url' || !match || !IMAGE_FORMATS.has(match[1])) {
          dropped.add('unsupported_content_part')
        } else if (image?.detail && image.detail !== 'auto') dropped.add('image_detail')
      }
    }
  }
  if (req.tools?.some((tool) => tool.function.strict === true)) dropped.add('strict_tool_schema')
  return [...dropped]
}
