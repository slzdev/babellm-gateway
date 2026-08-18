# Forced Upstream Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator force the gateway to open its upstream request as a stream even when the client asked for a single body, so providers that refuse long non-streaming requests can still serve them.

**Architecture:** A resolved `Candidate.forceUpstreamStream` boolean (provider column, catalog-model override) reaches `createAdapter`, which composes two new wrappers around the adapter it was going to build anyway. Each wrapper replaces one non-streaming method with a drained call to its streaming sibling, collapsed back into a single body by a new pure module. The request handler, the routing loop and all four adapters are untouched.

**Tech Stack:** TypeScript, Next.js 16 (App Router, server actions), Drizzle ORM + Postgres, Vitest, shadcn/ui + Base UI.

**Spec:** `docs/superpowers/specs/2026-08-18-forced-upstream-streaming-design.md`

## Global Constraints

- **Never point tests at port 5432.** This worktree's `.env.test` already names `babellm_test_force_stream` on **5434**. Do not edit it, do not run `pnpm test:db:down` (it destroys sibling worktrees' containers). The containers are already running.
- Run the suite with `pnpm test`. Run one file with `pnpm vitest run <path>`. Run one test with `pnpm vitest run <path> -t '<name>'`.
- `pnpm typecheck` and `pnpm lint` must pass before every commit.
- Commit after every task. Never use bare `git stash`.
- The setting is spelled `force_upstream_stream` in SQL, `forceUpstreamStream` in TypeScript everywhere it names the column or the resolved candidate value, and `forceStream` **only** as the `TargetSettings` key (Task 5).
- `??`, never `||`, when resolving the model override over the provider value — `false` on the model must beat `true` on the provider.
- Two-space indent, no semicolons, single quotes. Match the density of explanatory comments in the file you are editing: this codebase comments *why*, at length, and a bare implementation will look wrong in it.
- Do not add a response header or a request-log field for forced requests. That was decided against.

---

### Task 1: `collapseChatStream`

Turns a `ChatCompletionChunk` stream back into a single `ChatCompletion`. Pure, no I/O, no database.

**Files:**
- Create: `src/lib/adapters/collapse.ts`
- Test: `tests/lib/adapters/collapse.test.ts`

**Interfaces:**
- Consumes: `ChatCompletion`, `ChatCompletionChunk` from `@/lib/adapters/types`.
- Produces: `collapseChatStream(chunks: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletion>` — used by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/adapters/collapse.test.ts`:

```ts
import { expect, test } from 'vitest'
import { collapseChatStream } from '@/lib/adapters/collapse'
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import toolCallStream from '../../fixtures/openai-tool-call-stream.json'

async function* stream(chunks: unknown[]): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) yield chunk as ChatCompletionChunk
}

/** The shape every OpenAI-compatible chunk shares, so a test only has to
 *  spell the part it is about. */
function chunk(choices: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-up',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4o-mini',
    choices,
    ...extra,
  }
}

test('concatenates content deltas into one message', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: 'lo' }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  ]))

  expect(result.object).toBe('chat.completion')
  expect(result.id).toBe('chatcmpl-up')
  expect(result.model).toBe('gpt-4o-mini')
  expect(result.created).toBe(1)
  expect(result.choices).toHaveLength(1)
  expect(result.choices[0].message.role).toBe('assistant')
  expect(result.choices[0].message.content).toBe('Hello')
  expect(result.choices[0].finish_reason).toBe('stop')
})

test('reassembles a tool call from the streamed fixture', async () => {
  const result = await collapseChatStream(stream(toolCallStream))

  expect(result.choices[0].finish_reason).toBe('tool_calls')
  expect(result.choices[0].message.tool_calls).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
  }])
  // The fixture's last chunk carries usage and an EMPTY choices array. It must
  // contribute usage without inventing a second choice.
  expect(result.choices).toHaveLength(1)
  expect(result.usage).toEqual({ prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 })
})

test('merges two tool calls by their own index, not the choice index', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: '{"x"' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'b', arguments: '{"y"' } },
    ] }, finish_reason: null }]),
    chunk([{ index: 0, delta: { tool_calls: [
      { index: 1, function: { arguments: ':2}' } },
      { index: 0, function: { arguments: ':1}' } },
    ] }, finish_reason: 'tool_calls' }]),
  ]))

  expect(result.choices[0].message.tool_calls).toEqual([
    { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
    { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{"y":2}' } },
  ])
})

test('accumulates reasoning_content separately from content', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { reasoning_content: 'ing' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }]),
  ]))

  const message = result.choices[0].message as { content: string | null; reasoning_content?: string }
  expect(message.content).toBe('answer')
  expect(message.reasoning_content).toBe('thinking')
})

test('content absent throughout collapses to null, not an empty string', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }]),
  ]))

  expect(result.choices[0].message.content).toBeNull()
})

test('an empty content delta still yields an empty string, not null', async () => {
  // The provider said "content: ''" — that is a statement, unlike never
  // mentioning content at all.
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }]),
  ]))

  expect(result.choices[0].message.content).toBe('')
})

test('emits multiple choices in index order regardless of arrival order', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 1, delta: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }]),
    chunk([{ index: 0, delta: { role: 'assistant', content: 'first' }, finish_reason: 'stop' }]),
  ]))

  expect(result.choices.map((c) => c.index)).toEqual([0, 1])
  expect(result.choices[0].message.content).toBe('first')
  expect(result.choices[1].message.content).toBe('second')
})

test('usage stays undefined when no chunk carried any', async () => {
  const result = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }]),
  ]))

  expect(result.usage).toBeUndefined()
})

test('concatenates logprobs across chunks and leaves them null when absent', async () => {
  const withLogprobs = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { content: 'a' }, finish_reason: null, logprobs: { content: [{ token: 'a' }] } }]),
    chunk([{ index: 0, delta: { content: 'b' }, finish_reason: 'stop', logprobs: { content: [{ token: 'b' }] } }]),
  ]))
  expect(withLogprobs.choices[0].logprobs).toEqual({ content: [{ token: 'a' }, { token: 'b' }], refusal: null })

  const without = await collapseChatStream(stream([
    chunk([{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }]),
  ]))
  expect(without.choices[0].logprobs).toBeNull()
})

test('a stream that yields nothing throws rather than returning an empty completion', async () => {
  await expect(collapseChatStream(stream([]))).rejects.toThrow(
    /stream ended without producing/i,
  )
})

test('propagates an error thrown mid-stream', async () => {
  async function* failing(): AsyncIterable<ChatCompletionChunk> {
    yield chunk([{ index: 0, delta: { content: 'a' }, finish_reason: null }]) as ChatCompletionChunk
    throw new Error('upstream exploded')
  }

  await expect(collapseChatStream(failing())).rejects.toThrow('upstream exploded')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/lib/adapters/collapse.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/adapters/collapse"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/adapters/collapse.ts`:

```ts
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
  // the request. Throwing rather than returning an empty completion is what
  // lets execute()'s chain classify it as retryable and fail over.
  if (!head) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/adapters/collapse.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean. If the `as ChatCompletion` cast at the end is the only way to satisfy the SDK's exact types, keep it — but do not add casts inside the accumulation, where they would hide real shape mistakes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adapters/collapse.ts tests/lib/adapters/collapse.test.ts
git commit -m "feat(adapters): collapse a chat chunk stream into one completion"
```

---

### Task 2: `collapseResponseStream`

The Responses half. Far simpler than Task 1 — every terminal event carries the whole `Response` object, so there is nothing to reassemble.

**Files:**
- Modify: `src/lib/adapters/collapse.ts`
- Test: `tests/lib/adapters/collapse.test.ts`

**Interfaces:**
- Consumes: `ResponsesResult`, `ResponseStreamEvent` from `@/lib/adapters/types`.
- Produces: `collapseResponseStream(events: AsyncIterable<ResponseStreamEvent>): Promise<ResponsesResult>` — used by Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/adapters/collapse.test.ts` (and extend the import on line 2 to `import { collapseChatStream, collapseResponseStream } from '@/lib/adapters/collapse'`):

```ts
import type { ResponseStreamEvent } from '@/lib/adapters/types'
import responsesToolCallStream from '../../fixtures/openai-responses-tool-call-stream.json'

async function* events(list: unknown[]): AsyncIterable<ResponseStreamEvent> {
  for (const event of list) yield event as ResponseStreamEvent
}

test('returns the response carried by response.completed, verbatim', async () => {
  const result = await collapseResponseStream(events(responsesToolCallStream))

  const terminal = responsesToolCallStream.at(-1) as { type: string; response: unknown }
  expect(terminal.type).toBe('response.completed')
  expect(result).toEqual(terminal.response)
})

test('returns rather than throws on response.failed', async () => {
  // A real non-streaming responses.create answers HTTP 200 with
  // status: "failed", so the collapsed path must be indistinguishable.
  const failed = { id: 'resp_1', object: 'response', status: 'failed', error: { message: 'nope' } }
  const result = await collapseResponseStream(events([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    { type: 'response.failed', response: failed },
  ]))

  expect(result).toEqual(failed)
})

test('returns the response carried by response.incomplete', async () => {
  const incomplete = { id: 'resp_2', object: 'response', status: 'incomplete' }
  const result = await collapseResponseStream(events([
    { type: 'response.created', response: { id: 'resp_2', status: 'in_progress' } },
    { type: 'response.incomplete', response: incomplete },
  ]))

  expect(result).toEqual(incomplete)
})

test('a stream that ends with no terminal event throws', async () => {
  await expect(collapseResponseStream(events([
    { type: 'response.created', response: { id: 'resp_3', status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: 'hi' },
  ]))).rejects.toThrow(/ended without a terminal/i)
})

test('an empty responses stream throws', async () => {
  await expect(collapseResponseStream(events([]))).rejects.toThrow(/ended without a terminal/i)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/lib/adapters/collapse.test.ts`
Expected: FAIL — `collapseResponseStream is not a function`. The Task 1 tests still pass.

- [ ] **Step 3: Write the implementation**

Add to `src/lib/adapters/collapse.ts` — extend the type import on line 1 to
`import type { ChatCompletion, ChatCompletionChunk, ResponsesResult, ResponseStreamEvent } from './types'`, then append:

```ts
/**
 * Every event that ends a Responses stream carries the complete `Response`
 * object, so unlike the chat collapser this one reconstructs nothing: it
 * waits for a terminal event and hands back exactly what the provider sent.
 * Hosted-tool output, reasoning items and encrypted content therefore survive
 * a forced stream untouched.
 */
const TERMINAL_EVENTS = new Set([
  'response.completed', 'response.incomplete', 'response.failed',
])

export async function collapseResponseStream(
  events: AsyncIterable<ResponseStreamEvent>,
): Promise<ResponsesResult> {
  for await (const event of events) {
    // `response.failed` returns rather than throws: a non-streaming
    // responses.create answers 200 with status "failed" and an `error` field,
    // and a forced request must be indistinguishable from an unforced one.
    if (TERMINAL_EVENTS.has(event.type) && 'response' in event) {
      return event.response as ResponsesResult
    }
  }

  throw new Error('The upstream stream ended without a terminal response event.')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/adapters/collapse.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adapters/collapse.ts tests/lib/adapters/collapse.test.ts
git commit -m "feat(adapters): collapse a responses event stream into one response"
```

---

### Task 3: The forced-stream wrappers

Two adapter wrappers that swap a non-streaming method for its drained streaming sibling. No wiring yet — Task 5 composes them.

**Files:**
- Modify: `src/lib/adapters/wrappers.ts`
- Test: `tests/lib/adapters/wrappers.test.ts` (create)

**Interfaces:**
- Consumes: `collapseChatStream`, `collapseResponseStream` (Tasks 1–2); `ChatOnlyAdapter`, `ProviderAdapter` from `./types`.
- Produces:
  - `withForcedChatStream<T extends ChatOnlyAdapter>(adapter: T): T`
  - `withForcedResponseStream(adapter: ProviderAdapter): ProviderAdapter`

  Both used by `registry.ts` in Task 5.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/adapters/wrappers.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { withForcedChatStream, withForcedResponseStream } from '@/lib/adapters/wrappers'
import type {
  AttemptContext, ChatCompletionChunk, ProviderAdapter, ResponseStreamEvent,
} from '@/lib/adapters/types'

const ctx = {
  upstreamModel: 'gpt-4o-mini',
  requestId: 'req_1',
  signal: new AbortController().signal,
} as AttemptContext

function baseAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    chat: vi.fn(async () => { throw new Error('chat should not be called') }),
    chatStream: async function* (): AsyncIterable<ChatCompletionChunk> {
      yield {
        id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      } as ChatCompletionChunk
    },
    respond: vi.fn(async () => { throw new Error('respond should not be called') }),
    respondStream: async function* (): AsyncIterable<ResponseStreamEvent> {
      yield { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } } as ResponseStreamEvent
    },
    ...overrides,
  } as ProviderAdapter
}

test('withForcedChatStream serves chat() from chatStream()', async () => {
  const adapter = baseAdapter()
  const forced = withForcedChatStream(adapter)

  const result = await forced.chat({ model: 'virtual', messages: [] } as never, ctx)

  expect(result.choices[0].message.content).toBe('hi')
  expect(adapter.chat).not.toHaveBeenCalled()
})

test('withForcedChatStream leaves chatStream and every other method alone', async () => {
  const listModels = vi.fn(async () => [])
  const adapter = baseAdapter({ listModels })
  const forced = withForcedChatStream(adapter)

  expect(forced.chatStream).toBe(adapter.chatStream)
  expect(forced.respond).toBe(adapter.respond)
  expect(forced.respondStream).toBe(adapter.respondStream)
  expect(forced.listModels).toBe(listModels)
})

test('withForcedResponseStream serves respond() from respondStream()', async () => {
  const adapter = baseAdapter()
  const forced = withForcedResponseStream(adapter)

  const result = await forced.respond({ model: 'virtual', input: 'hi' } as never, ctx)

  expect(result).toEqual({ id: 'resp_1', status: 'completed' })
  expect(adapter.respond).not.toHaveBeenCalled()
})

test('withForcedResponseStream leaves chat alone, so the two compose independently', async () => {
  const adapter = baseAdapter()
  const forced = withForcedResponseStream(adapter)

  expect(forced.chat).toBe(adapter.chat)
  expect(forced.chatStream).toBe(adapter.chatStream)
})

test('an upstream failure mid-stream surfaces as a rejected chat(), which is what lets the chain fail over', async () => {
  const adapter = baseAdapter({
    chatStream: async function* (): AsyncIterable<ChatCompletionChunk> {
      yield {
        id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      } as ChatCompletionChunk
      throw new Error('upstream died')
    },
  })

  await expect(
    withForcedChatStream(adapter).chat({ model: 'virtual', messages: [] } as never, ctx),
  ).rejects.toThrow('upstream died')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/lib/adapters/wrappers.test.ts`
Expected: FAIL — `withForcedChatStream is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/adapters/wrappers.ts`, and extend its import block with
`import { collapseChatStream, collapseResponseStream } from './collapse'`:

```ts
/**
 * Opens the upstream leg as a stream even when the client asked for one body.
 *
 * Some providers refuse a non-streaming request outright once the model and
 * token budget put it over their long-request ceiling — Anthropic answers
 * "Streaming is required for operations that may take longer than 10 minutes"
 * before generating anything. The client's `stream` says what the CLIENT wants
 * to receive; whether the upstream leg is streamed is a property of the
 * endpoint, which is an operator's fact. This wrapper is how that fact gets
 * applied, under `force_upstream_stream` on the provider or the catalog model.
 *
 * Generic in `T` rather than typed to `ChatOnlyAdapter` so wrapping a full
 * `ProviderAdapter` returns a full `ProviderAdapter`: registry.ts composes
 * this with withForcedResponseStream on the Responses adapter, and a widened
 * return type there would drop `respond` on the floor.
 *
 * Draining the stream here rather than in the handler is also what keeps
 * failover working: `chat()` rejects before the gateway has committed an HTTP
 * response, so execute()'s chain sees an ordinary error and tries the next
 * target — where today the same mid-response failure is unrecoverable.
 */
export function withForcedChatStream<T extends ChatOnlyAdapter>(adapter: T): T {
  return {
    ...adapter,
    async chat(req, ctx) {
      return collapseChatStream(adapter.chatStream(req, ctx))
    },
  }
}

/**
 * The Responses-native counterpart. Only the Responses adapter needs it: every
 * other adapter reaches `respond` through withRespondViaChat, which is built
 * on the `chat` withForcedChatStream has already replaced.
 *
 * Applied on top of withForcedChatStream rather than instead of it, so a
 * Responses request never round-trips through chat shape merely because chat
 * is being forced too.
 */
export function withForcedResponseStream(adapter: ProviderAdapter): ProviderAdapter {
  return {
    ...adapter,
    async respond(req, ctx) {
      return collapseResponseStream(adapter.respondStream(req, ctx))
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/adapters/wrappers.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adapters/wrappers.ts tests/lib/adapters/wrappers.test.ts
git commit -m "feat(adapters): add forced upstream streaming wrappers"
```

---

### Task 4: Schema, migration and resolution

The two columns and the resolved `Candidate` field. Nothing reads the field yet — Task 5 wires it.

**Files:**
- Modify: `src/lib/db/schema.ts:40` (providers) and `:151-157` (catalog_models)
- Create: `drizzle/0010_*.sql` (generated)
- Modify: `src/lib/gateway/resolve.ts` — `Candidate`, `findVirtualModel`, `resolveDirect`
- Test: `tests/lib/gateway/resolve.test.ts`

**Interfaces:**
- Produces: `Candidate.forceUpstreamStream: boolean` — read by Task 5's `execute.ts` wiring.

- [ ] **Step 1: Add the columns to the schema**

In `src/lib/db/schema.ts`, in the `providers` table immediately after the `apiFlavor` column and its comment:

```ts
  // A column rather than a `config` key for the same reason as apiFlavor: it
  // decides how a request is made, not what a model is, and it is read on the
  // request path by resolve().
  forceUpstreamStream: boolean('force_upstream_stream').notNull().default(false),
```

In `catalogModels`, inside the existing block of gateway columns, after `messagesPath` — and extend that block's comment, which currently says "NULL means 'inherit the provider' in all four", to say **all five**:

```ts
    // Tri-state, unlike the boolean on providers: NULL inherits, `true` forces
    // and `false` refuses to force even where the provider does. A default
    // would collapse the last two into each other.
    forceUpstreamStream: boolean('force_upstream_stream'),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0010_<name>.sql` containing exactly two `ALTER TABLE … ADD COLUMN` statements, plus a `drizzle/meta/_journal.json` entry with `"idx": 10`.

Read the generated SQL and confirm it contains no `DROP` and no enum change. If it contains anything else, stop and report.

- [ ] **Step 3: Write the failing resolution tests**

Add to `tests/lib/gateway/resolve.test.ts` — follow the seeding style already in that file, and set the provider/catalog columns directly with `db.update`:

```ts
test('a candidate inherits force_upstream_stream from its provider', async () => {
  const seeded = await seedGateway()
  await db.update(providers)
    .set({ forceUpstreamStream: true })
    .where(eq(providers.id, seeded.provider.id))

  const { candidates } = await resolveModel(seeded.virtualModel)

  expect(candidates[0].forceUpstreamStream).toBe(true)
})

test('a candidate defaults to not forcing', async () => {
  const seeded = await seedGateway()

  const { candidates } = await resolveModel(seeded.virtualModel)

  expect(candidates[0].forceUpstreamStream).toBe(false)
})

test('a catalog model set to false beats a provider set to true', async () => {
  // The reason the column is nullable with no default: `false` has to be a
  // decision, not an absence, or a model could never opt out of its provider.
  const seeded = await seedGateway()
  await db.update(providers)
    .set({ forceUpstreamStream: true })
    .where(eq(providers.id, seeded.provider.id))
  await db.insert(catalogModels).values({
    providerId: seeded.provider.id,
    modelId: seeded.upstreamModel,
    forceUpstreamStream: false,
  })

  const { candidates } = await resolveModel(seeded.virtualModel)

  expect(candidates[0].forceUpstreamStream).toBe(false)
})

test('a catalog model set to true beats a provider left off', async () => {
  const seeded = await seedGateway()
  await db.insert(catalogModels).values({
    providerId: seeded.provider.id,
    modelId: seeded.upstreamModel,
    forceUpstreamStream: true,
  })

  const { candidates } = await resolveModel(seeded.virtualModel)

  expect(candidates[0].forceUpstreamStream).toBe(true)
})

test('a catalog model that says nothing inherits the provider', async () => {
  const seeded = await seedGateway()
  await db.update(providers)
    .set({ forceUpstreamStream: true })
    .where(eq(providers.id, seeded.provider.id))
  await db.insert(catalogModels).values({
    providerId: seeded.provider.id,
    modelId: seeded.upstreamModel,
    forceUpstreamStream: null,
  })

  const { candidates } = await resolveModel(seeded.virtualModel)

  expect(candidates[0].forceUpstreamStream).toBe(true)
})

test('a direct provider/model address resolves it from its catalog row', async () => {
  const seeded = await seedGateway()
  await db.update(providers)
    .set({ forceUpstreamStream: true })
    .where(eq(providers.id, seeded.provider.id))
  await db.insert(catalogModels).values({
    providerId: seeded.provider.id,
    modelId: 'gpt-4o-direct',
    forceUpstreamStream: false,
  })

  const { candidates } = await resolveModel(`${seeded.provider.name}/gpt-4o-direct`)

  expect(candidates[0].forceUpstreamStream).toBe(false)
})
```

Make sure `providers` and `catalogModels` are imported from `@/lib/db/schema` and `eq` from `drizzle-orm` at the top of the file; add whichever is missing.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run tests/lib/gateway/resolve.test.ts`
Expected: FAIL — `forceUpstreamStream` is not a property on `Candidate` (typecheck) and `undefined` at runtime. The migration is applied automatically by `tests/setup/global-setup.ts` on the run.

- [ ] **Step 5: Add the field to `Candidate` and both resolvers**

In `src/lib/gateway/resolve.ts`, in the `Candidate` interface directly below `apiFlavor`:

```ts
  /**
   * Whether to open the upstream leg as a stream even when the client asked
   * for a single body, for a provider that refuses long non-streaming
   * requests. Resolved rather than nullable, for the same reason `apiFlavor`
   * is: the routing loop must never have to work out where the answer came
   * from.
   */
  forceUpstreamStream: boolean
```

In `findVirtualModel`'s `candidates: rows.map(...)`, below the `apiFlavor` line:

```ts
      // `??`, not `||`: `false` on the model is a decision to opt out, and
      // must beat `true` on the provider.
      forceUpstreamStream: catalog?.forceUpstreamStream ?? provider.forceUpstreamStream,
```

And the same line in `resolveDirect`'s single candidate, using `row.catalog` and `row.provider`:

```ts
      forceUpstreamStream: row.catalog.forceUpstreamStream ?? row.provider.forceUpstreamStream,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/gateway/resolve.test.ts`
Expected: PASS, including the six new tests.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: all green. Any other file constructing a `Candidate` literal will now fail typecheck for the missing field — add `forceUpstreamStream: false` to those fixtures.

- [ ] **Step 8: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/db/schema.ts drizzle src/lib/gateway/resolve.ts tests/lib/gateway/resolve.test.ts
git commit -m "feat(routing): resolve force_upstream_stream per provider and model"
```

---

### Task 5: `TargetSettings` and adapter composition

Collapses `createAdapter`'s four trailing positional arguments into one object, adds `forceStream` to it, and composes the Task 3 wrappers. This is the task that makes the feature work end to end.

**Files:**
- Modify: `src/lib/adapters/registry.ts` — `createAdapter`, `flavoredAdapter`
- Modify: `src/lib/adapters/types.ts` — add `TargetSettings`
- Modify: `src/lib/gateway/execute.ts:33-38,148-153` — `ExecuteDeps.createAdapter` and the call
- Modify: `src/lib/gateway/handler.ts:26-32` — `GatewayDeps.createAdapter`
- Test: `tests/lib/adapters/registry.test.ts`, `tests/lib/gateway/execute.test.ts:284`
- Test: `tests/gateway/forced-stream.test.ts` (create)

**Interfaces:**
- Consumes: `Candidate.forceUpstreamStream` (Task 4); `withForcedChatStream`, `withForcedResponseStream` (Task 3).
- Produces:
  - `interface TargetSettings { flavor?: ApiFlavor; paths?: ModelPathOverrides | null; maxOutputTokens?: number | null; forceStream?: boolean }` in `@/lib/adapters/types`
  - `createAdapter(provider: ProviderRow, settings?: TargetSettings): ProviderAdapter`

- [ ] **Step 1: Write the failing composition tests**

Add to `tests/lib/adapters/registry.test.ts`. It already has `provider()`,
`stubFetch()`, `calledPath()`, `chatCtx` and `chatBody`; reuse all of them.
`provider()` builds a `ProviderRow` literal, so add `forceUpstreamStream: false`
to its defaults (Task 4 added the column, and the literal is cast to
`ProviderRow`, so a missing field would otherwise go unnoticed until runtime).

Add two helpers beside `stubFetch`:

```ts
/** The SSE body a streaming upstream returns. `stubFetch` answers JSON, which
 *  the SDK's streaming path cannot parse — a forced adapter calls the
 *  streaming endpoint, so it needs an event stream to drain. */
function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function stubStreamingFetch(body: string) {
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  )
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

/** What the adapter actually put on the wire. */
function sentBody(fetchSpy: ReturnType<typeof stubFetch>): Record<string, unknown> {
  return JSON.parse(String(fetchSpy.mock.calls[0][1].body))
}

const streamedChunk = {
  id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: 'model-x',
  choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
}
```

Then the tests:

```ts
test('an unforced provider still calls the non-streaming endpoint', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(provider({ apiFlavor: 'chat_completions' }))
  await adapter.chat(chatBody, chatCtx)

  expect(sentBody(fetchSpy).stream).toBe(false)
})

test('forceStream makes chat() ask the upstream for a stream', async () => {
  const fetchSpy = stubStreamingFetch(sse(streamedChunk))
  const adapter = createAdapter(
    provider({ apiFlavor: 'chat_completions' }),
    { forceStream: true },
  )
  const result = await adapter.chat(chatBody, chatCtx)

  // The upstream saw a stream…
  expect(sentBody(fetchSpy).stream).toBe(true)
  // …and the caller got a single completion regardless.
  expect(result.object).toBe('chat.completion')
  expect(result.choices[0].message.content).toBe('hi')
})

test('the provider column forces even when settings name no forceStream', async () => {
  const fetchSpy = stubStreamingFetch(sse(streamedChunk))
  const adapter = createAdapter(provider({ forceUpstreamStream: true }))
  await adapter.chat(chatBody, chatCtx)

  // catalog sync and the provider test button call createAdapter with no
  // settings at all; the provider's own column has to still apply.
  expect(sentBody(fetchSpy).stream).toBe(true)
})

test('an explicit forceStream: false beats a provider column set to true', async () => {
  const fetchSpy = stubFetch()
  const adapter = createAdapter(
    provider({ forceUpstreamStream: true }),
    { forceStream: false },
  )
  await adapter.chat(chatBody, chatCtx)

  // This is how a catalog model opts out of its provider.
  expect(sentBody(fetchSpy).stream).toBe(false)
})

test('forceStream reaches respond() through withRespondViaChat on a chat-only adapter', async () => {
  const fetchSpy = stubStreamingFetch(sse(streamedChunk))
  const adapter = createAdapter(
    provider({ apiFlavor: 'chat_completions' }),
    { forceStream: true },
  )
  await adapter.respond({ model: 'fast', input: 'hi' } as never, chatCtx)

  // The forcing wrapper goes INSIDE withRespondViaChat, so the Responses
  // ingress is forced too. Reversing that order would leave this at false.
  expect(calledPath(fetchSpy)).toMatch(/\/chat\/completions$/)
  expect(sentBody(fetchSpy).stream).toBe(true)
})

test('forceStream on a responses provider forces respond() natively', async () => {
  const fetchSpy = stubStreamingFetch(sse(
    { type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed' } },
  ))
  const adapter = createAdapter(provider({ apiFlavor: 'responses' }), { forceStream: true })
  const result = await adapter.respond({ model: 'fast', input: 'hi' } as never, chatCtx)

  expect(calledPath(fetchSpy)).toMatch(/\/responses$/)
  expect(sentBody(fetchSpy).stream).toBe(true)
  // Verbatim, not reassembled: the terminal event carried the whole object.
  expect(result).toEqual({ id: 'resp_1', object: 'response', status: 'completed' })
})

test('forceStream on a gemini provider forces it too', async () => {
  // Flavor says nothing about Gemini, but forcing is about the upstream call
  // rather than the dialect, so the gemini branch must apply it as well.
  const adapter = createAdapter(
    provider({ adapter: 'gemini', credentials: encryptJson({ apiKey: 'k' }) }),
    { forceStream: true },
  )

  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.respond).toBe('function')
})
```

**Note on the last test:** Gemini goes through `@google/genai`, not `fetch`
directly, so asserting the wire body there would mean stubbing that SDK. If the
existing Gemini adapter tests under `tests/lib/adapters/gemini/` already have a
client stub, use it and assert the streaming method was called; otherwise leave
this test as the construction check above and rely on
`tests/lib/adapters/wrappers.test.ts` for the behaviour, which is adapter-agnostic.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/lib/adapters/registry.test.ts`
Expected: FAIL — `createAdapter` still takes positional arguments, so `{ forceStream: true }` is passed where `flavor` is expected.

- [ ] **Step 3: Add `TargetSettings` to `types.ts`**

Append to `src/lib/adapters/types.ts`:

```ts
/**
 * What resolution worked out about one target, as opposed to what the provider
 * is. One object rather than four positional arguments on `createAdapter`,
 * because they are all the same kind of fact and four consecutive optionals
 * have nothing but their order to tell them apart at a call site.
 *
 * Every field is optional so a caller with no model in hand — catalog sync,
 * the provider test button — can omit the lot and get the provider's own
 * settings.
 */
export interface TargetSettings {
  flavor?: ApiFlavor
  paths?: ModelPathOverrides | null
  maxOutputTokens?: number | null
  forceStream?: boolean
}
```

Add `import type { ApiFlavor } from '@/lib/api-flavors'` to that file if it is not already imported.

- [ ] **Step 4: Rewrite `createAdapter` and `flavoredAdapter`**

In `src/lib/adapters/registry.ts`:

```ts
export function createAdapter(
  provider: ProviderRow,
  settings: TargetSettings = {},
): ProviderAdapter {
  const flavor = settings.flavor ?? provider.apiFlavor
  const forceStream = settings.forceStream ?? provider.forceUpstreamStream
  const maxOutputTokens = settings.maxOutputTokens ?? null
  const runtime = withModelPaths(resolveProviderRuntime(provider), settings.paths)

  switch (runtime.adapter) {
    case 'openai':
      return flavoredAdapter(runtime, flavor, maxOutputTokens, forceStream)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return flavoredAdapter(runtime, flavor, maxOutputTokens, forceStream)
    case 'gemini': {
      // Gemini speaks neither OpenAI dialect natively, so flavor says nothing
      // about it: the adapter translates from Chat Completions either way,
      // and gets `respond`/`respondStream` from the same wrapper any
      // chat-only adapter does. Forcing applies all the same — it is about the
      // upstream call, not the dialect.
      const base = createGeminiAdapter(runtime)
      return withRespondViaChat(forceStream ? withForcedChatStream(base) : base, runtime.name)
    }
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
  }
}
```

and:

```ts
/**
 * Dispatches on the flavor the model resolved to, then applies forcing.
 *
 * For a chat-only adapter the forcing wrapper goes INSIDE withRespondViaChat,
 * so `respond` derives from the already-forced `chat` and one wrapper covers
 * both ingresses. Reversing that order would leave the Responses ingress
 * calling a non-streaming upstream on a provider that refuses one.
 */
function flavoredAdapter(
  runtime: ProviderRuntime,
  flavor: ApiFlavor,
  maxOutputTokens: number | null,
  forceStream: boolean,
): ProviderAdapter {
  if (flavor === 'responses') {
    const base = createResponsesAdapter(runtime)
    // Both native pairs wrapped independently: a Responses request must not
    // round-trip through chat shape merely because chat is forced too.
    return forceStream ? withForcedResponseStream(withForcedChatStream(base)) : base
  }

  const base = flavor === 'anthropic_messages'
    ? createAnthropicAdapter(runtime, maxOutputTokens)
    : createOpenAIAdapter(runtime)

  return withRespondViaChat(forceStream ? withForcedChatStream(base) : base, runtime.name)
}
```

Import `withForcedChatStream` and `withForcedResponseStream` from `./wrappers`, and `TargetSettings` from `./types`.

- [ ] **Step 5: Narrow the two dep types and the call site**

In `src/lib/gateway/execute.ts`, replace the `createAdapter` member of `ExecuteDeps` with:

```ts
  createAdapter: (provider: ProviderRow, settings: TargetSettings) => ProviderAdapter
```

and the call at the top of the attempt loop with:

```ts
      adapter = deps.createAdapter(candidate.provider, {
        flavor: candidate.apiFlavor,
        paths: candidate.pathOverrides,
        maxOutputTokens: candidate.maxOutputTokens,
        forceStream: candidate.forceUpstreamStream,
      })
```

Update the import to pull `TargetSettings` from `@/lib/adapters/types` and drop the now-unused `ApiFlavor` and `ModelPathOverrides` imports if nothing else in the file uses them.

Make the identical change to `GatewayDeps.createAdapter` in `src/lib/gateway/handler.ts`.

- [ ] **Step 6: Update every existing call site**

Run: `pnpm typecheck`

Fix each error. Expected shape of the changes:
- `tests/lib/adapters/registry.test.ts` — roughly twenty calls; `createAdapter(provider(), 'responses')` becomes `createAdapter(provider(), { flavor: 'responses' })`, `createAdapter(provider(), 'chat_completions', paths)` becomes `createAdapter(provider(), { flavor: 'chat_completions', paths })`, and so on.
- `tests/lib/gateway/execute.test.ts:284` — the `toHaveBeenCalledWith` assertion becomes two arguments: the provider row and an object.
- `src/lib/catalog/sync.ts:161` and `src/lib/admin/providers.ts:230` call `createAdapter(provider)` with one argument and need **no change** — verify that is still true.

- [ ] **Step 7: Write the end-to-end gateway test**

Create `tests/gateway/forced-stream.test.ts`. Model the file on `tests/gateway/service-tier.test.ts`, which already seeds a provider, drives `runGatewayRequest` through the chat handler and asserts on what the adapter received.

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { resetDb } from '../helpers/db'
import { chatRequest, seedGateway } from '../helpers/gateway'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

const chunk = {
  id: 'chatcmpl-up', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

const completion = {
  id: 'chatcmpl-up', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
}

function sseResponse(...events: unknown[]): Response {
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(payload, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

/** What the gateway put on the wire for attempt `n` (0-based). */
function sentBody(fetchSpy: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> {
  return JSON.parse(String(fetchSpy.mock.calls[n][1].body))
}

async function force(providerId: string) {
  await db.update(providers)
    .set({ forceUpstreamStream: true })
    .where(eq(providers.id, providerId))
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// These tests deliberately go through the REAL createAdapter rather than
// fakeAdapterDeps, stubbing global fetch instead: the behaviour under test is
// the composition in registry.ts, and a fake adapter would stub out precisely
// the thing that has to be proved.

test('a stream:false client against a forced target gets one body while the upstream streamed', async () => {
  const { apiKey, provider } = await seedGateway()
  await force(provider.id)
  const fetchSpy = vi.fn().mockResolvedValue(sseResponse(chunk))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleChatCompletions(chatRequest({ ...body, stream: false }, apiKey))

  expect(sentBody(fetchSpy).stream).toBe(true)
  expect(response.headers.get('content-type')).toMatch(/application\/json/)
  const parsed = await response.json()
  expect(parsed.object).toBe('chat.completion')
  expect(parsed.choices[0].message.content).toBe('hello')
  expect(parsed.model).toBe('house-model')
})

test('the same request against an unforced target calls the non-streaming upstream', async () => {
  const { apiKey } = await seedGateway()
  const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(completion))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleChatCompletions(chatRequest({ ...body, stream: false }, apiKey))

  expect(sentBody(fetchSpy).stream).toBe(false)
  expect((await response.json()).object).toBe('chat.completion')
})

test('a client that asked for a stream is unaffected by forcing', async () => {
  const { apiKey, provider } = await seedGateway()
  await force(provider.id)
  const fetchSpy = vi.fn().mockResolvedValue(sseResponse(chunk))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleChatCompletions(chatRequest({ ...body, stream: true }, apiKey))

  expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
  expect(await response.text()).toContain('data: [DONE]')
})

test('a forced upstream that produces nothing fails over to the next target', async () => {
  // The regression guard for the wrapper ever being moved outside execute():
  // draining inside chat() is what makes a mid-response upstream failure
  // pre-commit and therefore recoverable.
  const { apiKey, provider } = await seedGateway()
  await force(provider.id)
  const fetchSpy = vi.fn()
    // An upstream that opened a stream and said nothing: collapseChatStream
    // throws, execute() classifies it retryable and tries again.
    .mockResolvedValueOnce(new Response('data: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }))
    .mockResolvedValueOnce(sseResponse(chunk))
  vi.stubGlobal('fetch', fetchSpy)

  const response = await handleChatCompletions(chatRequest({ ...body, stream: false }, apiKey))

  expect(response.status).toBe(200)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect((await response.json()).choices[0].message.content).toBe('hello')
})
```

**Note on the last test:** it relies on `seedGateway`'s single target being
retried, which `virtual_models.max_attempts` (default 3) allows. If the seeded
model turns out to allow only one attempt, seed two targets with `seedTargets`
instead and force only the first — the assertion to keep is that the client got
200 after the forced attempt failed, not the exact number of fetch calls.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: all green, including the four new gateway tests.

- [ ] **Step 9: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/adapters src/lib/gateway/execute.ts src/lib/gateway/handler.ts tests
git commit -m "feat(gateway): force upstream streaming per target"
```

---

### Task 6: Timeout default and editable `timeoutMs`

Drops the attempt ceiling to 30 s and gives the previously hidden config key a validated parser and a client-importable default.

**Files:**
- Create: `src/lib/timeouts.ts`
- Modify: `src/lib/gateway/execute.ts:11` — import the constant instead of declaring it
- Test: `tests/lib/timeouts.test.ts` (create), `tests/lib/gateway/execute.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_TIMEOUT_MS = 30_000`
  - `MAX_TIMEOUT_MS = 3_600_000`
  - `parseTimeoutMs(raw: string): number | null` — `null` for blank, throws for invalid. Used by Task 7.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/timeouts.test.ts`:

```ts
import { expect, test } from 'vitest'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, parseTimeoutMs } from '@/lib/timeouts'

test('the default attempt timeout is 30 seconds', () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
})

test('a blank value clears back to the default', () => {
  expect(parseTimeoutMs('')).toBeNull()
  expect(parseTimeoutMs('   ')).toBeNull()
})

test('a valid integer is returned as a number', () => {
  expect(parseTimeoutMs('600000')).toBe(600_000)
  expect(parseTimeoutMs(' 600000 ')).toBe(600_000)
})

test('the bounds are inclusive at both ends', () => {
  expect(parseTimeoutMs('1')).toBe(1)
  expect(parseTimeoutMs(String(MAX_TIMEOUT_MS))).toBe(MAX_TIMEOUT_MS)
})

test('a value outside the bounds is an error, not a silently ignored field', () => {
  expect(() => parseTimeoutMs('0')).toThrow(/between 1 and 3600000/)
  expect(() => parseTimeoutMs('-5')).toThrow(/between 1 and 3600000/)
  expect(() => parseTimeoutMs(String(MAX_TIMEOUT_MS + 1))).toThrow(/between 1 and 3600000/)
})

test('a non-integer is an error', () => {
  expect(() => parseTimeoutMs('abc')).toThrow(/whole number of milliseconds/)
  expect(() => parseTimeoutMs('1.5')).toThrow(/whole number of milliseconds/)
  expect(() => parseTimeoutMs('1e5')).toThrow(/whole number of milliseconds/)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/lib/timeouts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/timeouts.ts`:

```ts
/**
 * How long one upstream attempt may take.
 *
 * Its own module rather than a constant in execute.ts, for the reason
 * api-flavors.ts gives: the provider dialogs are client components and need
 * the default to render as a placeholder, and execute.ts is server-only.
 *
 * 30 seconds, not the two minutes this gateway shipped with. A ceiling that
 * high delays every failover behind a wedged provider, and the providers that
 * genuinely need longer — anything serving a long reasoning request, which is
 * the same set that needs force_upstream_stream — are better served by an
 * explicit, visible number than by a hidden default nobody can find.
 */
export const DEFAULT_TIMEOUT_MS = 30_000

/** One hour. Past this a request has outlived any client that would still be
 *  waiting for it, and the value is far more likely to be a typo. */
export const MAX_TIMEOUT_MS = 3_600_000

/**
 * Reads the provider form's timeout field.
 *
 * Blank returns null, which the action turns into deleting the config key —
 * so "blank" keeps meaning "the default" rather than pinning today's default
 * forever. Anything unparseable throws, because a silently ignored timeout is
 * exactly the failure an operator would not notice until a request they
 * expected to survive ten minutes died at thirty seconds.
 */
export function parseTimeoutMs(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  // Deliberately stricter than Number(): "1e5" and "1.5" both parse to a
  // finite number, and neither is a millisecond count anyone typed on purpose.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('The request timeout must be a whole number of milliseconds.')
  }

  const value = Number(trimmed)
  if (value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`The request timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`)
  }
  return value
}
```

- [ ] **Step 4: Point `execute.ts` at the constant**

In `src/lib/gateway/execute.ts`, delete the local `const DEFAULT_TIMEOUT_MS = 120_000` and import it:

```ts
import { DEFAULT_TIMEOUT_MS } from '@/lib/timeouts'
```

`attemptContext` already reads `config.timeoutMs ?? DEFAULT_TIMEOUT_MS`; leave that line alone.

- [ ] **Step 5: Add the execute tests**

Add to `tests/lib/gateway/execute.test.ts`, following its existing `attemptContext` cases:

```ts
test('an attempt times out after 30 seconds by default', () => {
  vi.useFakeTimers()
  const ctx = attemptContext(candidate('oai'), 'req_1', new AbortController().signal)

  vi.advanceTimersByTime(29_999)
  expect(ctx.signal.aborted).toBe(false)
  vi.advanceTimersByTime(2)
  expect(ctx.signal.aborted).toBe(true)

  vi.useRealTimers()
})

test('config.timeoutMs overrides the default', () => {
  vi.useFakeTimers()
  const target = candidate('oai')
  target.provider = { ...target.provider, config: JSON.stringify({ timeoutMs: 600_000 }) }
  const ctx = attemptContext(target, 'req_1', new AbortController().signal)

  vi.advanceTimersByTime(60_000)
  expect(ctx.signal.aborted).toBe(false)

  vi.useRealTimers()
})
```

If the file's `candidate()` helper returns a frozen or shared object, build the second test's candidate from scratch rather than mutating it.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/lib/timeouts.test.ts tests/lib/gateway/execute.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: all green. If a test elsewhere depended on the 120 s ceiling, fix the test — the new default is intended.

- [ ] **Step 8: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/timeouts.ts src/lib/gateway/execute.ts tests/lib/timeouts.test.ts tests/lib/gateway/execute.test.ts
git commit -m "feat(gateway): drop the attempt timeout to 30s and make it parseable"
```

---

### Task 7: Provider admin layer and dialogs

Surfaces both settings on the Providers page.

**Files:**
- Modify: `src/lib/admin/providers.ts` — `ProviderInput`, `ProviderListItem`, `listProviders`, `createProvider`, `updateProvider`
- Modify: `src/app/(admin)/providers/actions.ts` — both actions
- Modify: `src/app/(admin)/providers/provider-form.tsx`, `edit-provider-form.tsx`
- Test: `tests/lib/admin/providers.test.ts`

**Interfaces:**
- Consumes: `parseTimeoutMs`, `DEFAULT_TIMEOUT_MS` (Task 6); `providers.forceUpstreamStream` (Task 4).
- Produces: `ProviderListItem.forceUpstreamStream: boolean` and `ProviderListItem.timeoutMs: number | null`, read by the edit dialog.

- [ ] **Step 1: Write the failing admin tests**

Add to `tests/lib/admin/providers.test.ts`:

```ts
test('a provider is created not forcing upstream streams', async () => {
  const row = await createProvider({
    name: 'p1', adapter: 'openai', credentials: { apiKey: 'sk-x' },
  })

  expect(row.forceUpstreamStream).toBe(false)
})

test('createProvider stores forceUpstreamStream when asked', async () => {
  const row = await createProvider({
    name: 'p2', adapter: 'openai', credentials: { apiKey: 'sk-x' }, forceUpstreamStream: true,
  })

  expect(row.forceUpstreamStream).toBe(true)
})

test('updateProvider leaves forceUpstreamStream alone when the key is absent', async () => {
  const created = await createProvider({
    name: 'p3', adapter: 'openai', credentials: { apiKey: 'sk-x' }, forceUpstreamStream: true,
  })

  const updated = await updateProvider(created.id, { name: 'renamed' })

  expect(updated.forceUpstreamStream).toBe(true)
})

test('updateProvider can turn forcing back off', async () => {
  const created = await createProvider({
    name: 'p4', adapter: 'openai', credentials: { apiKey: 'sk-x' }, forceUpstreamStream: true,
  })

  const updated = await updateProvider(created.id, { forceUpstreamStream: false })

  expect(updated.forceUpstreamStream).toBe(false)
})

test('listProviders surfaces forcing and the configured timeout', async () => {
  await createProvider({
    name: 'p5',
    adapter: 'openai',
    credentials: { apiKey: 'sk-x' },
    forceUpstreamStream: true,
    config: { timeoutMs: 600_000 },
  })

  const [item] = await listProviders()

  expect(item.forceUpstreamStream).toBe(true)
  expect(item.timeoutMs).toBe(600_000)
})

test('listProviders reports a null timeout when the provider has none, so the form can show a placeholder', async () => {
  await createProvider({ name: 'p6', adapter: 'openai', credentials: { apiKey: 'sk-x' } })

  const [item] = await listProviders()

  expect(item.timeoutMs).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/lib/admin/providers.test.ts`
Expected: FAIL — `forceUpstreamStream` is not on `ProviderInput`.

- [ ] **Step 3: Extend the admin layer**

In `src/lib/admin/providers.ts`:

- add `forceUpstreamStream?: boolean` to `ProviderInput`, below `apiFlavor`
- add to `ProviderListItem`, below `apiFlavor`:

```ts
  forceUpstreamStream: boolean
  /** The provider's configured attempt timeout, or null when it uses the
   *  default — absent rather than defaulted so the edit form can leave its box
   *  empty, which is how the form says "use the default". */
  timeoutMs: number | null
```

- in `listProviders`'s `rows.map`, add `forceUpstreamStream: row.forceUpstreamStream` and `timeoutMs: readTimeoutMs(row.config)`, with a small local helper beside `readRegistryNamespace`:

```ts
/** Only a number that is actually stored. A config written by hand could hold
 *  anything, and a bad value must not reach the form as a prefilled default
 *  the operator would then re-save. */
function readTimeoutMs(config: string): number | null {
  const value = parseProviderConfig(config).timeoutMs
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}
```

- in `createProvider`'s `.values({...})`: `forceUpstreamStream: input.forceUpstreamStream ?? false,`
- in `updateProvider`'s `.set({...})`: `forceUpstreamStream: input.forceUpstreamStream ?? existing.forceUpstreamStream,`

- [ ] **Step 4: Run the admin tests**

Run: `pnpm vitest run tests/lib/admin/providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the server actions**

In `src/app/(admin)/providers/actions.ts`, add a reader beside `apiFlavorFrom` — note the value-matching idiom is the one already used for the `Switch` in `catalog/actions.ts:196`:

```ts
/**
 * The Switch posts its `name` only when checked, and Base UI posts the string
 * "on". An unchecked switch therefore submits nothing, which is "false" and
 * not "leave it alone" — the field is rendered for every adapter, so absence
 * is always a real answer.
 */
function forceUpstreamStreamFrom(formData: FormData): boolean {
  return !['false', 'off', null, ''].includes(formData.get('forceUpstreamStream') as string | null)
}
```

In **both** `createProviderAction` and `updateProviderAction`:

- inside the existing `try` that builds `config`, after the namespace lines, add:

```ts
    const timeoutMs = parseTimeoutMs(String(formData.get('timeoutMs') ?? ''))
    if (timeoutMs === null) delete config.timeoutMs
    else config.timeoutMs = timeoutMs
```

  `parseTimeoutMs` throws on a bad value, and both actions already wrap this
  block in a `try` that returns `{ error: … }`, so an invalid timeout becomes a
  form error with no further work.

- add `forceUpstreamStream: forceUpstreamStreamFrom(formData),` to the
  `createProvider`/`updateProvider` argument object.

Import `parseTimeoutMs` from `@/lib/timeouts`.

In `createProviderAction` the config is built with `mergeProviderPaths(...)` and
assigned to a `let config`; make sure the timeout lines run after that
assignment and before `createProvider` is called.

- [ ] **Step 6: Add the fields to both dialogs**

In `src/app/(admin)/providers/provider-form.tsx`, inside the `grid` after
`<RegistryNamespaceField … />`, and **outside** any `adapter === …` condition —
the setting is about the upstream call, not the dialect:

```tsx
        <div className="space-y-2">
          <Label htmlFor="timeoutMs">Request timeout (ms)</Label>
          <Input
            id="timeoutMs"
            name="timeoutMs"
            type="number"
            min="1"
            max={MAX_TIMEOUT_MS}
            placeholder={String(DEFAULT_TIMEOUT_MS)}
          />
          <p className="text-xs text-muted-foreground">
            How long one attempt may take before the gateway gives up and tries the
            next target. Blank uses {DEFAULT_TIMEOUT_MS} ms. Raise it for a provider
            that serves long requests.
          </p>
        </div>

        <div className="space-y-2 sm:col-span-2">
          <div className="flex items-center gap-2">
            <Switch id="forceUpstreamStream" name="forceUpstreamStream" />
            <Label htmlFor="forceUpstreamStream">Force upstream streaming</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Open the upstream request as a stream even when the client asked for a
            single response. Some providers refuse long non-streaming requests. The
            client still gets one response — only the upstream leg changes. This is
            the default for every model on the provider — override it per model on
            the Catalog page.
          </p>
        </div>
```

Import `Switch` from `@/components/ui/switch` and `DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS` from `@/lib/timeouts`.

Make the same addition to `edit-provider-form.tsx`, with the id suffixed by
`provider.id` as its neighbours are, `defaultValue={provider.timeoutMs ?? ''}`
on the input, and `defaultChecked={provider.forceUpstreamStream}` on the switch.

- [ ] **Step 7: Verify the switch actually posts**

Run: `pnpm test`
Expected: all green.

Then confirm the `Switch` submits under its `name`. `catalog-forms.tsx:263`
already relies on exactly this (`registryEnabled`, read back at
`catalog/actions.ts:196`), so it is established in this codebase — but verify
rather than assume, by reading `catalog/actions.ts:196` and confirming your
reader uses the same idiom. If Base UI's Switch turns out not to post a form
value, fall back to `<input type="checkbox" name="forceUpstreamStream" />`
matching the `useInstanceRole` field in the same file, and say so in the commit
message.

- [ ] **Step 8: Typecheck, lint, build and commit**

```bash
pnpm typecheck && pnpm lint && pnpm build
git add src/lib/admin/providers.ts "src/app/(admin)/providers" tests/lib/admin/providers.test.ts
git commit -m "feat(admin): set forced streaming and request timeout per provider"
```

---

### Task 8: Catalog admin layer and gateway dialog

The per-model override.

**Files:**
- Create: `src/components/admin/force-stream-select.tsx`
- Modify: `src/lib/admin/catalog.ts` — `CatalogListItem`, `toListItem`/`listCatalog`, `ModelGatewayInput`, `setModelGateway`
- Modify: `src/app/(admin)/catalog/actions.ts` — `setModelGatewayAction`
- Modify: `src/app/(admin)/catalog/catalog-forms.tsx` — `GatewaySettingsDialog`
- Test: `tests/lib/admin/catalog.test.ts`

**Interfaces:**
- Consumes: `catalogModels.forceUpstreamStream` (Task 4).
- Produces: `ForceStreamSelect({ id, defaultValue, providerDefault })` posting `forceUpstreamStream` as `''` (inherit), `'true'` or `'false'`.

- [ ] **Step 1: Write the failing catalog tests**

Add to `tests/lib/admin/catalog.test.ts`, using its existing `seedCatalog`,
`makeProvider`, `listing` and `registry` helpers — do not introduce new ones.

```ts
/** The one catalog row `seedCatalog(['gpt-4o'])` produces. */
async function onlyModel() {
  const [row] = await db.select().from(catalogModels)
  return row
}

test('a model inherits by default, which listCatalog reports as null', async () => {
  await seedCatalog(['gpt-4o'])

  const [item] = await listCatalog()

  expect(item.forceUpstreamStream).toBeNull()
  expect(item.providerForceUpstreamStream).toBe(false)
})

test('listCatalog surfaces the provider default so the dialog can name it', async () => {
  const provider = await seedCatalog(['gpt-4o'])
  await db.update(providers)
    .set({ forceUpstreamStream: true })
    .where(eq(providers.id, provider.id))

  const [item] = await listCatalog()

  // The dialog's "(inherit — forced)" label reads this, so an operator can see
  // what blank means without opening the Providers page.
  expect(item.providerForceUpstreamStream).toBe(true)
  expect(item.forceUpstreamStream).toBeNull()
})

test('setModelGateway stores an explicit true', async () => {
  await seedCatalog(['gpt-4o'])
  const model = await onlyModel()

  await setModelGateway(model.id, { forceUpstreamStream: true })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  expect(row.forceUpstreamStream).toBe(true)
})

test('setModelGateway stores an explicit false, which is not the same as inheriting', async () => {
  await seedCatalog(['gpt-4o'])
  const model = await onlyModel()

  await setModelGateway(model.id, { forceUpstreamStream: false })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  // Not null: "never force" has to survive a provider that forces.
  expect(row.forceUpstreamStream).toBe(false)
})

test('setModelGateway clears back to inherit on null', async () => {
  await seedCatalog(['gpt-4o'])
  const model = await onlyModel()

  await setModelGateway(model.id, { forceUpstreamStream: true })
  await setModelGateway(model.id, { forceUpstreamStream: null })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  expect(row.forceUpstreamStream).toBeNull()
})

test('setModelGateway leaves the field alone when the key is absent', async () => {
  await seedCatalog(['gpt-4o'])
  const model = await onlyModel()

  await setModelGateway(model.id, { forceUpstreamStream: true })
  await setModelGateway(model.id, { apiFlavor: 'responses' })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  expect(row.forceUpstreamStream).toBe(true)
})

test('a re-sync does not reset the setting', async () => {
  // The whole reason it is a column and not a catalog layer: sync() and
  // merge() must never be able to undo an operator's decision.
  const provider = await seedCatalog(['gpt-4o'])
  const model = await onlyModel()
  await setModelGateway(model.id, { forceUpstreamStream: true })

  await syncProvider(provider.id, { registry, createAdapterImpl: () => listing(['gpt-4o']) })

  const [row] = await db.select().from(catalogModels).where(eq(catalogModels.id, model.id))
  expect(row.forceUpstreamStream).toBe(true)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/lib/admin/catalog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the catalog admin layer**

In `src/lib/admin/catalog.ts`:

- `CatalogListItem` gains, beside `apiFlavor` and `providerApiFlavor`:

```ts
  forceUpstreamStream: boolean | null
  providerForceUpstreamStream: boolean
```

- the row mapper gains `forceUpstreamStream: row.forceUpstreamStream` and
  `providerForceUpstreamStream`, sourced the same way `providerApiFlavor` is —
  add `providerForceUpstreamStream: providers.forceUpstreamStream` to
  `listCatalog`'s `.select({...})`.
- `ModelGatewayInput` gains `forceUpstreamStream?: boolean | null`.
- `setModelGateway` gains, alongside the `apiFlavor` block and under the same
  comment that is already there:

```ts
  if (input.forceUpstreamStream !== undefined) {
    patch.forceUpstreamStream = input.forceUpstreamStream
  }
```

- [ ] **Step 4: Run the catalog tests**

Run: `pnpm vitest run tests/lib/admin/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the selector component**

Create `src/components/admin/force-stream-select.tsx`:

```tsx
'use client'

/**
 * The per-model forced-streaming override. A three-option select rather than a
 * switch, because the field is genuinely tri-state: a model can inherit its
 * provider, force, or refuse to force where its provider does. A switch has
 * nowhere to put the third.
 *
 * Lives in components/admin beside api-flavor-select for the same reason: the
 * dialogs that render it are client components and cannot import the
 * server-only admin modules the values come from.
 *
 * "(inherit)" submits an empty string, which the action turns back into NULL.
 */
export function ForceStreamSelect({
  id,
  defaultValue,
  providerDefault,
}: {
  id: string
  defaultValue?: boolean | null
  /** Shown in the inherit option so an operator can see what blank means
   *  without opening the Providers page. */
  providerDefault: boolean
}) {
  return (
    <select
      id={id}
      name="forceUpstreamStream"
      defaultValue={defaultValue === null || defaultValue === undefined ? '' : String(defaultValue)}
      className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
    >
      <option value="">
        (inherit — {providerDefault ? 'forced' : 'not forced'})
      </option>
      <option value="true">Force</option>
      <option value="false">Never force</option>
    </select>
  )
}
```

- [ ] **Step 6: Wire the action and the dialog**

In `src/app/(admin)/catalog/actions.ts`, beside `apiFlavorValue`:

```ts
/** Three states over the wire: "" is inherit (NULL), "true" and "false" are
 *  decisions. Absent is treated as inherit rather than false, so a dialog that
 *  ever stops rendering the field cannot silently clear it. */
function forceUpstreamStreamValue(value: FormDataEntryValue | null): boolean | null {
  const raw = String(value ?? '')
  if (raw === '') return null
  return raw === 'true'
}
```

and add to the `setModelGateway` call:

```ts
      forceUpstreamStream: forceUpstreamStreamValue(formData.get('forceUpstreamStream')),
```

In `src/app/(admin)/catalog/catalog-forms.tsx`, inside `GatewaySettingsDialog`
directly after the API-flavor block:

```tsx
      <div className="space-y-2">
        <Label htmlFor={`gateway-force-stream-${item.id}`}>Forced upstream streaming</Label>
        <ForceStreamSelect
          id={`gateway-force-stream-${item.id}`}
          defaultValue={item.forceUpstreamStream}
          providerDefault={item.providerForceUpstreamStream}
        />
        <p className="text-xs text-muted-foreground">
          Call this model with a stream even when the client asked for a single
          response. The client still gets one response.
        </p>
      </div>
```

Import `ForceStreamSelect` from `@/components/admin/force-stream-select`.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 8: Typecheck, lint, build and commit**

```bash
pnpm typecheck && pnpm lint && pnpm build
git add src/lib/admin/catalog.ts src/components/admin/force-stream-select.tsx "src/app/(admin)/catalog" tests/lib/admin/catalog.test.ts
git commit -m "feat(admin): override forced upstream streaming per catalog model"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the setting**

In the section that describes `api_flavor` and per-model gateway settings, add a
paragraph in the README's existing voice:

> Some providers refuse a non-streaming request that might run long — Anthropic
> answers *"Streaming is required for operations that may take longer than 10
> minutes"* before generating anything. **Force upstream streaming** on the
> provider, or on one catalog model, makes the gateway ask for a stream and
> collapse it back into a single response. The client still sends
> `stream: false` and still gets one body; only the upstream leg changes.

- [ ] **Step 2: Warn about the timeout change**

Add, near the deployment or configuration notes:

```markdown
> [!WARNING]
> One upstream attempt may take **30 seconds** before the gateway gives up and
> fails over. Raise **Request timeout** on any provider that serves long
> requests — a provider set to force upstream streaming in order to survive a
> ten-minute request will still be cut off at thirty seconds otherwise.
```

If you are upgrading a deployment that predates this, the previous ceiling was
120 seconds: anything that relied on it needs an explicit timeout set.

- [ ] **Step 3: Verify and commit**

Run: `pnpm lint`
Expected: clean.

```bash
git add README.md
git commit -m "docs: document forced upstream streaming and the 30s attempt timeout"
```

---

## Final verification

- [ ] `pnpm test` — full suite green
- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm build` — clean
- [ ] `git status` — clean tree; the `AGENTS.md` block regenerated by `next dev` is committed with the work if it appears, per the note at the top of that file
- [ ] Manually confirm against a real Anthropic provider: set **Force upstream streaming**, raise **Request timeout**, send a `stream: false` chat request, and check it returns a single body rather than the `upstream_error` that prompted this work
