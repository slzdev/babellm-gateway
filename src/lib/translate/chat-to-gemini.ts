import {
  FunctionCallingConfigMode,
  ThinkingLevel,
  type Candidate,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type ToolConfig,
} from '@google/genai'
import { mediaPart, type MediaKind } from '@/lib/adapters/gemini/media'
import { ProviderError } from '@/lib/gateway/errors'
import type { ChatCompletion, ChatCompletionChunk, ProviderConfig } from '@/lib/adapters/types'
import type { ChatCompletionRequest, ChatMessage } from '@/lib/schemas/chat'

/**
 * The media part types this translation carries, and the kind each denotes. A
 * Map rather than an object literal because the key is untrusted client input:
 * an object would answer to `constructor` and every other Object prototype key.
 */
const MEDIA_PARTS = new Map<string, MediaKind>([
  ['image_url', 'image'],
  ['video_url', 'video'],
])

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
}

function userParts(content: ChatMessage['content']): Part[] {
  if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : []
  if (!content) return []

  const parts: Part[] = []
  for (const part of content) {
    if (part.type === 'text') {
      const { text } = part as { text: string }
      if (text.length > 0) parts.push({ text })
      continue
    }

    const kind = MEDIA_PARTS.get(part.type)
    if (kind) {
      // Gemini takes a public or pre-signed url by reference, so this needs no
      // I/O and the translation stays pure. An unusable url throws from here,
      // which is deliberate: a request naming media the gateway cannot express
      // is a request whose answer would silently ignore what it was asked about.
      const media = (part as Record<string, { url?: unknown; mime_type?: unknown } | undefined>)[
        part.type
      ]
      // The schema's media shapes require a url, but a part that fails them
      // still parses through the catch-all member of the content union, so it
      // arrives here with the type of a media part and none of the substance.
      const url = media?.url
      const mimeType = media?.mime_type
      if (typeof url !== 'string' || url.length === 0) {
        throw new ProviderError({
          status: 400,
          code: 'invalid_media',
          message: `a ${part.type} content part carries no url`,
          retryable: false,
        })
      }
      parts.push(mediaPart(url, kind, typeof mimeType === 'string' ? mimeType : undefined))
      continue
    }

    // Audio and every other part type has no Gemini equivalent reachable from
    // this ingress. droppedParams reports it; failing here would contradict the
    // compatibility decision the whole module is built on.
  }
  return parts
}

/**
 * A Chat Completions `tool` message names its call by id; Gemini's
 * functionResponse names it by function name. Nothing in the message bridges
 * those, so the bridge is built from the conversation itself — every id the
 * gateway emitted on a previous turn is still present in the assistant
 * messages the client echoed back.
 */
function toolNamesById(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name)
  }
  return names
}

/** A JSON object, or null for anything else — an array and a bare scalar included. */
function asObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Reported by droppedParams rather than thrown.
  }
  return null
}

/**
 * `functionResponse.response` must be an object. Gemini reads an `output` key
 * as the function's return value, which is exactly what a non-JSON tool result
 * is.
 */
function toResponsePayload(text: string): Record<string, unknown> {
  return asObject(text) ?? { output: text }
}

export function toContents(
  messages: ChatMessage[],
): { contents: Content[]; systemInstruction: string } {
  const names = toolNamesById(messages)
  const contents: Content[] = []
  const system: string[] = []

  // Gemini expects alternation, and multi-turn clients routinely send two
  // messages in the same role in a row.
  function push(role: 'user' | 'model', parts: Part[]) {
    if (parts.length === 0) return
    const last = contents.at(-1)
    if (last?.role === role && last.parts) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      // `contents` accepts only user and model, so there is nowhere to put
      // these. Hoisting preserves the authority the client gave the text;
      // carrying it as a user turn would silently demote it to the untrusted
      // channel. droppedParams reports the reorder when one happened.
      const text = textOf(message.content)
      if (text.length > 0) system.push(text)
      continue
    }

    if (message.role === 'tool' || message.role === 'function') {
      // The deprecated function role carries its name directly, which is
      // precisely what Gemini wants — it is better served here than by the
      // Responses translator, which has to degrade it to text.
      const name =
        message.role === 'function'
          ? message.name
          : message.tool_call_id
            ? names.get(message.tool_call_id)
            : undefined
      const text = textOf(message.content)

      // No name means nothing for a functionResponse to correlate to. Emitting
      // one with a fabricated name would send a dangling reference upstream, so
      // the result is carried as data instead. `user`, not the system channel:
      // a tool result is third-party data, and giving prompt-injected content
      // authority the original request never granted it is the failure mode.
      if (!name) {
        push('user', [{ text: `[tool result] ${text}` }])
        continue
      }

      push('user', [{
        functionResponse: {
          ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
          name,
          response: toResponsePayload(text),
        },
      }])
      continue
    }

    if (message.role === 'assistant') {
      const parts: Part[] = []
      const text = textOf(message.content)
      if (text.length > 0) parts.push({ text })
      for (const call of message.tool_calls ?? []) {
        // The client's id travels back out as functionCall.id and must return
        // unchanged, or a tool loop breaks silently on its second turn.
        parts.push({
          functionCall: {
            id: call.id,
            name: call.function.name,
            args: asObject(call.function.arguments) ?? {},
          },
        })
      }
      push('model', parts)
      continue
    }

    push('user', userParts(message.content))
  }

  return { contents, systemInstruction: system.join('\n\n') }
}

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
}

function toFunctionDeclarations(
  tools: NonNullable<ChatCompletionRequest['tools']>,
): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    // `parametersJsonSchema` takes JSON Schema directly. The alternative field,
    // `parameters`, takes Gemini's own Schema type and would need a converter —
    // a translation layer inside a translation layer.
    ...(tool.function.parameters ? { parametersJsonSchema: tool.function.parameters } : {}),
  }))
}

function toToolConfig(choice: ChatCompletionRequest['tool_choice']): ToolConfig | undefined {
  if (choice === undefined) return undefined

  if (typeof choice === 'string') {
    const mode =
      choice === 'none'
        ? FunctionCallingConfigMode.NONE
        : choice === 'required'
          ? FunctionCallingConfigMode.ANY
          : FunctionCallingConfigMode.AUTO
    return { functionCallingConfig: { mode } }
  }

  return {
    functionCallingConfig: {
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: [choice.function.name],
    },
  }
}

function toResponseFormat(
  format: ChatCompletionRequest['response_format'],
): Pick<GenerateContentConfig, 'responseMimeType' | 'responseJsonSchema'> {
  if (!format) return {}

  if (format.type === 'json_schema') {
    const schema = (format as { json_schema?: { schema?: unknown } }).json_schema?.schema
    return {
      responseMimeType: 'application/json',
      ...(schema ? { responseJsonSchema: schema } : {}),
    }
  }

  if (format.type === 'json_object') return { responseMimeType: 'application/json' }

  return {}
}

function toStopSequences(stop: ChatCompletionRequest['stop']): string[] | undefined {
  if (stop == null) return undefined
  const list = (Array.isArray(stop) ? stop : [stop]).filter((value) => value.length > 0)
  return list.length > 0 ? list : undefined
}

function numberOf(req: ChatCompletionRequest, name: string): number | undefined {
  const value = (req as Record<string, unknown>)[name]
  return typeof value === 'number' ? value : undefined
}

export function toGeminiRequest(
  req: ChatCompletionRequest,
  upstreamModel: string,
  config: ProviderConfig = {},
): GenerateContentParameters {
  const { contents, systemInstruction } = toContents(req.messages)
  const maxTokens = req.max_completion_tokens ?? req.max_tokens ?? undefined
  const stopSequences = toStopSequences(req.stop)
  const toolConfig = toToolConfig(req.tool_choice)
  const frequencyPenalty = numberOf(req, 'frequency_penalty')
  const presencePenalty = numberOf(req, 'presence_penalty')

  const effort = req.reasoning_effort
  const thinkingLevel = effort ? THINKING_LEVELS[effort] : undefined
  // Sending `thinkingConfig` is only asked for when the client's own request
  // proves it expects thoughts, or when an admin has said so for this provider
  // — the same opt-in the Responses flavor defines, honoured here so one
  // provider setting means one thing across adapters.
  const wantsThoughts = thinkingLevel !== undefined || config.requestReasoningSummary === true

  const generation: GenerateContentConfig = {
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
    ...(req.temperature == null ? {} : { temperature: req.temperature }),
    ...(req.top_p == null ? {} : { topP: req.top_p }),
    ...(req.seed == null ? {} : { seed: req.seed }),
    ...(stopSequences ? { stopSequences } : {}),
    ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }),
    ...(presencePenalty === undefined ? {} : { presencePenalty }),
    // Not every Gemini model accepts candidateCount, and a rejected request is
    // fatal — it fails the whole chain rather than moving on. `n: 1` and `n`
    // absent mean the same thing, so the common case is sent as nothing and can
    // never trip that.
    ...(req.n != null && req.n > 1 ? { candidateCount: req.n } : {}),
    ...(req.tools?.length
      ? { tools: [{ functionDeclarations: toFunctionDeclarations(req.tools) }] }
      : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...toResponseFormat(req.response_format),
    ...(wantsThoughts
      ? { thinkingConfig: { includeThoughts: true, ...(thinkingLevel ? { thinkingLevel } : {}) } }
      : {}),
  }

  return { model: upstreamModel, contents, config: generation }
}

/**
 * Chat Completions parameters Gemini cannot express, plus the structural
 * degradations above. Dropped rather than rejected: SDKs and frameworks
 * routinely send these meaning nothing by them, and 400ing would make the
 * gateway unusable against a Gemini provider without per-client config.
 *
 * Everything named here is knowable from the request body alone, because
 * chat-handler computes this before any attempt runs. Runtime degradations —
 * an image that could not be fetched — go to the log instead.
 */
const UNMAPPABLE = [
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'parallel_tool_calls',
  'user',
] as const

/**
 * Values that mean "the default", which is also what Gemini does. Reporting
 * them would put a line in the header on nearly every request.
 *
 * Note what is deliberately NOT copied from chat-to-responses: its rule that
 * any `false` is inert. `parallel_tool_calls: false` is a real instruction that
 * Gemini cannot honour, and it must be reported.
 */
const INERT: Record<string, unknown> = {
  logprobs: false,
  parallel_tool_calls: true,
}

function isInert(name: string, value: unknown): boolean {
  if (name in INERT && value === INERT[name]) return true
  if (value === '') return true
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

function hoistsSystemMessage(messages: ChatMessage[]): boolean {
  const firstTurn = messages.findIndex((m) => m.role !== 'system' && m.role !== 'developer')
  if (firstTurn === -1) return false
  return messages
    .slice(firstTurn)
    .some((m) => m.role === 'system' || m.role === 'developer')
}

export function droppedParams(req: ChatCompletionRequest): string[] {
  const dropped: string[] = []

  for (const name of UNMAPPABLE) {
    const value = (req as Record<string, unknown>)[name]
    if (value === undefined || value === null) continue
    if (isInert(name, value)) continue
    dropped.push(name)
  }

  if (hoistsSystemMessage(req.messages)) dropped.push('system_message_hoisted')

  const names = toolNamesById(req.messages)
  if (
    req.messages.some(
      (m) => m.role === 'tool' && (!m.tool_call_id || !names.has(m.tool_call_id)),
    )
  ) {
    dropped.push('unmatched_tool_call_id')
  }

  // The deprecated `function` role carries its name directly rather than a
  // `tool_call_id`, and that name is optional on the schema. When it is
  // missing, toContents carries the message as untrusted user text instead of
  // a functionResponse — a distinct cause from an unresolved tool_call_id, so
  // it gets its own name rather than being folded into that one.
  if (req.messages.some((m) => m.role === 'function' && !m.name)) {
    dropped.push('unnamed_function_message')
  }

  if (
    req.messages.some((m) =>
      (m.tool_calls ?? []).some((call) => asObject(call.function.arguments) === null),
    )
  ) {
    dropped.push('malformed_tool_arguments')
  }

  if (
    req.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((part) => part.type !== 'text' && !MEDIA_PARTS.has(part.type)),
    )
  ) {
    dropped.push('unsupported_content_part')
  }

  if (req.reasoning_effort && !THINKING_LEVELS[req.reasoning_effort]) {
    dropped.push('reasoning_effort')
  }

  return dropped
}

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

const CONTENT_FILTER_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'RECITATION',
])

/**
 * Shared with the stream translator, which derives the same reason from the
 * candidate carried on a terminal chunk.
 */
function finishReasonFor(
  reason: string | undefined,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  // Truncation and filtering outrank a present tool call: the spec's table
  // (§3.7) assigns `tool_calls` under `STOP` only. A call that finished
  // MAX_TOKENS may have truncated arguments, and one that finished on a
  // content-filter reason was filtered — both would be hidden from the client
  // if `hasToolCalls` were checked first.
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason && CONTENT_FILTER_REASONS.has(reason)) return 'content_filter'
  if (hasToolCalls) return 'tool_calls'
  return 'stop'
}

/**
 * Gemini's functionCall.id is optional. Synthesizing one is safe here in a way
 * it is not when reading a client's tool result: this id is the gateway's own
 * output, and the next turn resolves it back to a name through the assistant
 * message the gateway itself produced. Namespaced by choice so `n > 1` cannot
 * collide.
 */
function synthesizedCallId(choiceIndex: number, callIndex: number): string {
  return `call_${choiceIndex}_${callIndex}`
}

function toToolCalls(candidate: Candidate, choiceIndex: number): ToolCall[] {
  const calls: ToolCall[] = []
  for (const part of candidate.content?.parts ?? []) {
    if (!part.functionCall) continue
    calls.push({
      id: part.functionCall.id ?? synthesizedCallId(choiceIndex, calls.length),
      type: 'function',
      function: {
        name: part.functionCall.name ?? '',
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      },
    })
  }
  return calls
}

/**
 * OpenAI's completion_tokens includes reasoning tokens; Gemini's
 * candidatesTokenCount does not. Getting this wrong would under-report
 * completion tokens on every thinking request, and cost is computed from these.
 */
function toUsage(usage: GenerateContentResponseUsageMetadata) {
  const promptTokens = usage.promptTokenCount ?? 0
  const thoughts = usage.thoughtsTokenCount ?? 0
  const completionTokens = (usage.candidatesTokenCount ?? 0) + thoughts

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokenCount ?? promptTokens + completionTokens,
    ...(thoughts > 0 ? { completion_tokens_details: { reasoning_tokens: thoughts } } : {}),
    ...(usage.cachedContentTokenCount
      ? { prompt_tokens_details: { cached_tokens: usage.cachedContentTokenCount } }
      : {}),
  }
}

function toChoice(candidate: Candidate, position: number) {
  const index = candidate.index ?? position
  const toolCalls = toToolCalls(candidate, index)
  let content = ''
  let reasoning = ''

  for (const part of candidate.content?.parts ?? []) {
    if (part.functionCall || typeof part.text !== 'string') continue
    if (part.thought) reasoning += part.text
    else content += part.text
  }

  return {
    index,
    message: {
      role: 'assistant' as const,
      content: content.length > 0 ? content : null,
      // Non-standard, and deliberately so: it is the convention DeepSeek, vLLM
      // and OpenRouter already use, which is why real clients render it.
      ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: finishReasonFor(candidate.finishReason, toolCalls.length > 0),
    logprobs: null,
  }
}

function createdAt(createTime: string | undefined): number {
  const parsed = createTime ? Date.parse(createTime) : Number.NaN
  return Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000)
}

export function fromGenerateContent(
  res: GenerateContentResponse,
  model: string,
): ChatCompletion {
  const candidates = res.candidates ?? []

  // A prompt Google refuses outright comes back with no candidates at all.
  // Surfacing it as a filtered choice rather than an exception matches how
  // OpenAI's own filter reads, and — more importantly — stops the routing loop
  // failing over to a provider that would filter it too.
  const choices =
    candidates.length > 0
      ? candidates.map(toChoice)
      : [{
          index: 0,
          message: { role: 'assistant' as const, content: null },
          finish_reason: res.promptFeedback?.blockReason ? 'content_filter' : 'stop',
          logprobs: null,
        }]

  return {
    id: res.responseId ?? '',
    object: 'chat.completion',
    created: createdAt(res.createTime),
    model: res.modelVersion ?? model,
    choices,
    ...(res.usageMetadata ? { usage: toUsage(res.usageMetadata) } : {}),
  } as ChatCompletion
}

/**
 * Gemini streams whole responses with partial candidates rather than semantic
 * events, so this translator is much smaller than the Responses one: there is
 * no output-index bookkeeping, because a functionCall part arrives complete.
 *
 * The state it does keep is per choice — which roles have been announced and
 * how many tool calls have been seen — because `n > 1` produces interleaved
 * candidates that a Chat Completions client expects to stay separated.
 */
export async function* fromGenerateContentStream(
  chunks: AsyncIterable<GenerateContentResponse>,
  req: ChatCompletionRequest,
  model: string,
): AsyncIterable<ChatCompletionChunk> {
  const rolesSent = new Set<number>()
  const toolCounts = new Map<number, number>()
  let created = Math.floor(Date.now() / 1000)
  let responseModel = model
  let usage: GenerateContentResponseUsageMetadata | undefined

  // Gemini always reports usage, so `include_usage` needs no upstream
  // parameter — only an opt-out honoured here.
  const includeUsage = req.stream_options?.include_usage !== false

  function chunk(
    index: number,
    delta: Record<string, unknown>,
    reason: string | null = null,
  ): ChatCompletionChunk {
    // The role rides the first chunk carrying real content rather than the
    // first chunk of any kind, so the eager first-chunk pull in startChatStream
    // keeps meaning "the upstream produced something" — which is what makes
    // failover and ttftMs measure what they claim to.
    const withRole = rolesSent.has(index) ? delta : { role: 'assistant', ...delta }
    rolesSent.add(index)

    return {
      id: '',
      object: 'chat.completion.chunk',
      created,
      model: responseModel,
      choices: [{ index, delta: withRole, finish_reason: reason }],
    } as ChatCompletionChunk
  }

  for await (const res of chunks) {
    if (res.modelVersion) responseModel = res.modelVersion
    if (res.createTime) created = createdAt(res.createTime)
    if (res.usageMetadata) usage = res.usageMetadata

    const candidates = res.candidates ?? []

    if (candidates.length === 0 && res.promptFeedback?.blockReason) {
      yield chunk(0, {}, 'content_filter')
      continue
    }

    for (const [position, candidate] of candidates.entries()) {
      const index = candidate.index ?? position

      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall) {
          const callIndex = toolCounts.get(index) ?? 0
          toolCounts.set(index, callIndex + 1)
          yield chunk(index, {
            tool_calls: [{
              index: callIndex,
              id: part.functionCall.id ?? synthesizedCallId(index, callIndex),
              type: 'function',
              function: {
                name: part.functionCall.name ?? '',
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              },
            }],
          })
        } else if (typeof part.text === 'string' && part.text.length > 0) {
          yield chunk(index, part.thought ? { reasoning_content: part.text } : { content: part.text })
        }
      }

      if (candidate.finishReason) {
        yield chunk(index, {}, finishReasonFor(candidate.finishReason, (toolCounts.get(index) ?? 0) > 0))
      }
    }
  }

  if (includeUsage && usage) {
    yield {
      id: '',
      object: 'chat.completion.chunk',
      created,
      model: responseModel,
      choices: [],
      usage: toUsage(usage),
    } as ChatCompletionChunk
  }
}
