import type { ChatCompletion, ChatCompletionChunk } from './types'

/**
 * Turns a chunk stream back into the single body the same request would have
 * returned unstreamed.
 *
 * Exists so that whether the upstream leg is streamed can be an operator's
 * decision rather than the client's: a provider that refuses long
 * non-streaming requests is still asked for a stream, and the client still
 * gets one response. See withForcedChatStream in ./wrappers.
 *
 * Pure and I/O-free on purpose — every fidelity question this feature has
 * (are tool calls reassembled, does reasoning survive, is usage kept) is
 * answerable by a unit test with a hand-written array.
 */

/** One choice under construction. Content and refusal start as `null` rather
 *  than `''` so "the provider never mentioned content" stays distinguishable
 *  from "the provider sent an empty string" — a tool-call-only completion has
 *  the former, and reporting it as `''` would misdescribe it. */
interface ChoiceAccumulator {
  index: number
  role: string
  content: string | null
  refusal: string | null
  reasoningContent: string | null
  finishReason: string | null
  toolCalls: Map<number, ToolCallAccumulator>
  logprobsContent: unknown[]
  logprobsRefusal: unknown[]
  sawLogprobs: boolean
}

interface ToolCallAccumulator {
  index: number
  id?: string
  type?: string
  name?: string
  arguments: string
}

/** Appends to a field that is `null` until something is actually said about
 *  it. `''` is something being said; absence is not. */
function append(current: string | null, delta: unknown): string | null {
  if (typeof delta !== 'string') return current
  return (current ?? '') + delta
}

function accumulatorFor(
  choices: Map<number, ChoiceAccumulator>,
  index: number,
): ChoiceAccumulator {
  const existing = choices.get(index)
  if (existing) return existing

  const created: ChoiceAccumulator = {
    index,
    role: 'assistant',
    content: null,
    refusal: null,
    reasoningContent: null,
    finishReason: null,
    toolCalls: new Map(),
    logprobsContent: [],
    logprobsRefusal: [],
    sawLogprobs: false,
  }
  choices.set(index, created)
  return created
}

/** Tool calls carry an `index` of their own, which counts calls within one
 *  choice and has nothing to do with the choice's index. Merging on the wrong
 *  one concatenates two different calls' arguments into a single unparseable
 *  string, so they get their own map per choice. */
function mergeToolCall(target: ChoiceAccumulator, raw: unknown): void {
  const call = raw as {
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }
  const index = call.index ?? 0

  let entry = target.toolCalls.get(index)
  if (!entry) {
    entry = { index, arguments: '' }
    target.toolCalls.set(index, entry)
  }

  // id, type and name arrive once, on the opening chunk; arguments stream.
  if (call.id) entry.id = call.id
  if (call.type) entry.type = call.type
  if (call.function?.name) entry.name = call.function.name
  if (typeof call.function?.arguments === 'string') {
    entry.arguments += call.function.arguments
  }
}

function finishChoice(accumulator: ChoiceAccumulator) {
  const toolCalls = [...accumulator.toolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .map((call) => ({
      id: call.id ?? '',
      type: call.type ?? 'function',
      function: { name: call.name ?? '', arguments: call.arguments },
    }))

  return {
    index: accumulator.index,
    message: {
      role: accumulator.role,
      content: accumulator.content,
      ...(accumulator.refusal === null ? {} : { refusal: accumulator.refusal }),
      // Not part of Chat Completions' own schema, but every translate module
      // emits it and responses-to-chat.ts reads it back off the unary
      // completion to rebuild a reasoning item. Dropping it here would lose
      // reasoning outright on a Responses request served by a forced
      // Anthropic target.
      ...(accumulator.reasoningContent === null
        ? {}
        : { reasoning_content: accumulator.reasoningContent }),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: accumulator.finishReason,
    logprobs: accumulator.sawLogprobs
      ? {
          content: accumulator.logprobsContent.length > 0 ? accumulator.logprobsContent : null,
          refusal: accumulator.logprobsRefusal.length > 0 ? accumulator.logprobsRefusal : null,
        }
      : null,
  }
}

export async function collapseChatStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
): Promise<ChatCompletion> {
  const choices = new Map<number, ChoiceAccumulator>()
  let head: ChatCompletionChunk | null = null
  let usage: ChatCompletionChunk['usage'] | undefined

  for await (const chunk of chunks) {
    head ??= chunk
    // Taken from whichever chunk carried one last: providers that send
    // stream_options.include_usage put it on a final chunk whose `choices` is
    // empty, which must not be read as a choice.
    if (chunk.usage) usage = chunk.usage

    for (const choice of chunk.choices ?? []) {
      const target = accumulatorFor(choices, choice.index ?? 0)
      const delta = (choice.delta ?? {}) as {
        role?: string
        content?: unknown
        refusal?: unknown
        reasoning_content?: unknown
        tool_calls?: unknown[]
      }

      if (delta.role) target.role = delta.role
      target.content = append(target.content, delta.content)
      target.refusal = append(target.refusal, delta.refusal)
      target.reasoningContent = append(target.reasoningContent, delta.reasoning_content)
      for (const call of delta.tool_calls ?? []) mergeToolCall(target, call)

      // Last non-null wins: a provider that repeats the reason on a trailing
      // chunk must not overwrite it with null.
      if (choice.finish_reason) target.finishReason = choice.finish_reason

      const logprobs = choice.logprobs as
        | { content?: unknown[] | null; refusal?: unknown[] | null }
        | null
        | undefined
      if (logprobs) {
        target.sawLogprobs = true
        target.logprobsContent.push(...(logprobs.content ?? []))
        target.logprobsRefusal.push(...(logprobs.refusal ?? []))
      }
    }
  }

  // An upstream that opened a stream and then said nothing has not answered
  // the request. That covers a stream with zero chunks, but also a stream
  // that carried only a trailing usage chunk (whose `choices` is deliberately
  // empty) and never produced a single choice — that is the same non-answer,
  // just with usage attached. Throwing rather than returning an empty
  // completion is what lets execute()'s chain classify it as retryable and
  // fail over.
  if (!head || choices.size === 0) {
    throw new Error('The upstream stream ended without producing any chunks.')
  }

  return {
    id: head.id,
    object: 'chat.completion',
    created: head.created,
    model: head.model,
    ...(head.system_fingerprint ? { system_fingerprint: head.system_fingerprint } : {}),
    ...(head.service_tier ? { service_tier: head.service_tier } : {}),
    choices: [...choices.values()]
      .sort((a, b) => a.index - b.index)
      .map(finishChoice),
    ...(usage ? { usage } : {}),
  } as ChatCompletion
}
