import type Anthropic from '@anthropic-ai/sdk'
import type { ProviderConfig } from '@/lib/adapters/types'
import type { ChatCompletionRequest, ChatMessage } from '@/lib/schemas/chat'

/** What Anthropic requires when neither the client nor the catalog states a
 *  ceiling. Deliberately modest: the fix for a model that needs more is its
 *  catalog entry, not a larger constant every model would inherit. */
const DEFAULT_MAX_TOKENS = 4096

/** OpenAI's effort vocabulary where it differs from Anthropic's. Anything
 *  absent here is forwarded verbatim, so a value either scale adds is
 *  validated upstream instead of being silently remapped here — the same
 *  decision the schema makes by typing reasoning_effort as a free string. */
const EFFORT_ALIASES: Record<string, string> = { minimal: 'low' }

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
}

/** A JSON object, or null for anything else — an array and a bare scalar
 *  included. Mirrors chat-to-gemini's helper of the same name. */
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
 * Splits a data URL into the two fields a base64 image source needs. Returns
 * null for anything that is not one, so an ordinary http url falls through to
 * the by-reference form Anthropic also accepts — no fetching, which is what
 * keeps this module pure.
 */
function dataUrl(url: string): { mediaType: string; data: string } | null {
  // `[\s\S]*` rather than a dotAll `.*`: the project's target predates ES2018,
  // where the `s` flag was added, and base64 data has no newlines to worry
  // about matching regardless.
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url)
  return match ? { mediaType: match[1], data: match[2] } : null
}

function imageBlock(url: string): Anthropic.ImageBlockParam {
  const inline = dataUrl(url)
  return inline
    ? {
        type: 'image',
        source: {
          type: 'base64',
          // The SDK's media_type is a closed union of the four types Anthropic
          // actually accepts; a data url's own claim is an arbitrary string, so
          // it is cast rather than narrowed. Anthropic rejects an unsupported
          // value itself — this module's job is to carry the client's claim
          // through unchanged, not to pre-validate it.
          media_type: inline.mediaType as Anthropic.Base64ImageSource['media_type'],
          data: inline.data,
        },
      }
    : { type: 'image', source: { type: 'url', url } }
}

function userBlocks(content: ChatMessage['content']): Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!content) return []

  const blocks: Anthropic.ContentBlockParam[] = []
  for (const part of content) {
    if (part.type === 'text') {
      const { text } = part as { text: string }
      if (text.length > 0) blocks.push({ type: 'text', text })
      continue
    }
    if (part.type === 'image_url') {
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url
      if (typeof url === 'string' && url.length > 0) blocks.push(imageBlock(url))
      continue
    }
    // Video and every other part type has no Messages equivalent.
    // droppedParams reports it; throwing here would contradict the
    // compatibility decision this module is built on.
  }
  return blocks
}

export function toMessages(
  messages: ChatMessage[],
): { messages: Anthropic.MessageParam[]; system: string } {
  const out: Anthropic.MessageParam[] = []
  const system: string[] = []

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      // Hoisted rather than carried as a user turn: `system` is where the
      // Messages API keeps operator authority, and demoting the text to the
      // untrusted channel is the failure mode. droppedParams reports the
      // reorder when one happened.
      const text = textOf(message.content)
      if (text.length > 0) system.push(text)
      continue
    }

    if (message.role === 'tool' || message.role === 'function') {
      const id = message.tool_call_id
      const text = textOf(message.content)
      // No id means nothing for a tool_result to correlate to. Carried as
      // plain user text instead of a dangling reference, exactly as the
      // Gemini translator does with an uncorrelatable function response.
      out.push(id
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
        : { role: 'user', content: [{ type: 'text', text: `[tool result] ${text}` }] })
      continue
    }

    if (message.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = []
      const text = textOf(message.content)
      if (text.length > 0) blocks.push({ type: 'text', text })
      for (const call of message.tool_calls ?? []) {
        // The client's id travels back out unchanged, or a tool loop breaks
        // silently on its second turn.
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: asObject(call.function.arguments) ?? {},
        })
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks })
      continue
    }

    const blocks = userBlocks(message.content)
    if (blocks.length > 0) out.push({ role: 'user', content: blocks })
  }

  return { messages: out, system: system.join('\n\n') }
}

function toTools(
  tools: NonNullable<ChatCompletionRequest['tools']>,
): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: (tool.function.parameters ?? { type: 'object' }) as Anthropic.Tool['input_schema'],
  }))
}

function toToolChoice(
  choice: ChatCompletionRequest['tool_choice'],
  parallel: boolean | undefined,
): Anthropic.ToolChoice | undefined {
  // `disable_parallel_tool_use` has no home of its own — it rides the tool
  // choice — so an explicit `parallel_tool_calls: false` has to synthesize a
  // choice the client never sent.
  const disable = parallel === false ? { disable_parallel_tool_use: true } : {}
  if (choice === undefined) {
    return parallel === false ? { type: 'auto', ...disable } : undefined
  }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any', ...disable }
  if (choice === 'auto') return { type: 'auto', ...disable }
  return { type: 'tool', name: choice.function.name, ...disable }
}

function toStopSequences(stop: ChatCompletionRequest['stop']): string[] | undefined {
  if (stop == null) return undefined
  const list = (Array.isArray(stop) ? stop : [stop]).filter((value) => value.length > 0)
  return list.length > 0 ? list : undefined
}

export function toMessagesRequest(
  req: ChatCompletionRequest,
  upstreamModel: string,
  config: ProviderConfig = {},
  maxOutputTokens: number | null = null,
): Anthropic.MessageCreateParams {
  const { messages, system } = toMessages(req.messages)
  const stopSequences = toStopSequences(req.stop)
  const toolChoice = toToolChoice(req.tool_choice, req.parallel_tool_calls)

  // `none` is a client saying it does not want thinking, which is expressed
  // by sending no thinking configuration at all rather than by an effort
  // level Anthropic has no name for.
  const effort = req.reasoning_effort && req.reasoning_effort !== 'none'
    ? EFFORT_ALIASES[req.reasoning_effort] ?? req.reasoning_effort
    : undefined
  // Asking a model that does not reason for thoughts is an upstream error and
  // the gateway cannot tell which kind of model it is addressing, so thinking
  // is requested only when the client's own request proves it expects it, or
  // an admin has said so for this provider — the same opt-in the Responses
  // flavor defines, honoured here so one provider setting means one thing
  // across adapters.
  const wantsThinking = effort !== undefined
    || (config.requestReasoningSummary === true && req.reasoning_effort !== 'none')

  return {
    model: upstreamModel,
    // Required by this API and optional in Chat Completions, so a client that
    // sent nothing still needs a number: the model's catalogued ceiling if it
    // has one, and a floor of last resort if it does not.
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(system ? { system } : {}),
    ...(req.temperature == null ? {} : { temperature: req.temperature }),
    ...(req.top_p == null ? {} : { top_p: req.top_p }),
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    ...(req.tools?.length ? { tools: toTools(req.tools) } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(req.user ? { metadata: { user_id: req.user } } : {}),
    ...(wantsThinking
      ? {
          // `display` is not decoration: the current models default to
          // `omitted`, which streams thinking blocks whose text is empty. A
          // gateway that left it out would relay silence.
          thinking: { type: 'adaptive', display: 'summarized' },
          ...(effort ? { output_config: { effort } } : {}),
        }
      : {}),
    // Cast for the same reason chat-to-responses.ts casts its result: this
    // object is assembled from optional spreads, and `adaptive` thinking and
    // `output_config` are recent enough that pinning them to the SDK's
    // current type would break the build on a version bump either way.
  } as Anthropic.MessageCreateParams
}
