# Gemini Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `gemini` adapter so a Gemini Developer API provider serves `/v1/chat/completions` requests through the existing routing loop, instead of returning `501 unsupported_operation`.

**Architecture:** A new `ProviderAdapter` that speaks Google's `generateContent` upstream and Chat Completions downstream. All translation lives in one pure module (`src/lib/translate/chat-to-gemini.ts`) with no I/O, mirroring `chat-to-responses.ts`. The adapter resolves image parts to Gemini `Part`s first — the only I/O the translation needs — and hands the translator a finished `Map`, which keeps the translator synchronous and testable with no client.

**Tech Stack:** TypeScript, Next.js 16, `@google/genai` 2.17.0, vitest, drizzle/Postgres (tests only).

**Spec:** `docs/superpowers/specs/2026-08-13-gemini-adapter-design.md`

## Global Constraints

- **Dependency:** `@google/genai` at exactly `2.17.0`, pinned with no caret — every dependency in `package.json` is pinned exactly.
- **Package manager:** `pnpm` (10.33.0). Never `npm install`.
- **Imports:** absolute `@/lib/...` for cross-directory, relative `../types` within `src/lib/adapters/`. Match the neighbouring file.
- **Gemini Developer API only.** Never set `vertexai`, `project`, or `location` on the client.
- **No new `ProviderAdapter` methods or fields.** The interface in `src/lib/adapters/types.ts` is not edited by this plan.
- **`ctx.signal` must reach every upstream call** — `generateContent`, `generateContentStream`, `files.upload`, the image `fetch`, and `models.list`. An adapter that drops it holds a connection open past client disconnect.
- **Never fail a request over an untranslatable input.** Degrade and report. This is the stance the whole translation layer is built on.
- **Test commands:** `pnpm test` (all), `pnpm vitest run <path>` (one file). `pnpm typecheck` and `pnpm lint` must pass before any commit.
- **Postgres must be running** for the suite: `docker compose up -d`. `.env.test` is gitignored — copy it from the main checkout if absent.
- **Commit style:** conventional commits, lowercase scope, e.g. `feat(gemini): …`, `test(gemini): …`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/adapters/gemini/errors.ts` | `ApiError` → `ProviderError`. Owns the retryable/fatal split. |
| `src/lib/translate/chat-to-gemini.ts` | Pure translation, both directions. No I/O, no client. |
| `src/lib/adapters/gemini/media.ts` | `image_url` → Gemini `Part`. The only I/O in the translation path. |
| `src/lib/adapters/gemini/client.ts` | `GoogleGenAI` construction and `models.list` → `DiscoveredModel[]`. |
| `src/lib/adapters/gemini/index.ts` | `createGeminiAdapter` — wires the four above to the `ProviderAdapter` contract. |
| `src/lib/adapters/registry.ts` | Modified: one `switch` case. |
| `src/lib/gateway/chat-handler.ts` | Modified: `droppedFor` dispatches on adapter before flavor. |

---

## Task 1: Dependency and error classification

**Files:**
- Modify: `package.json`
- Create: `src/lib/adapters/gemini/errors.ts`
- Test: `tests/lib/adapters/gemini/errors.test.ts`

**Interfaces:**
- Consumes: `ProviderError` from `@/lib/gateway/errors`.
- Produces: `toProviderError(err: unknown): ProviderError`.

- [ ] **Step 1: Install the dependency**

```bash
pnpm add @google/genai@2.17.0
```

Then confirm `package.json` lists `"@google/genai": "2.17.0"` with no caret. Fix it by hand if pnpm added one.

- [ ] **Step 2: Write the failing test**

Create `tests/lib/adapters/gemini/errors.test.ts`:

```ts
import { expect, test } from 'vitest'
import { ApiError } from '@google/genai'
import { toProviderError } from '@/lib/adapters/gemini/errors'
import { ProviderError } from '@/lib/gateway/errors'

test.each([408, 409, 429, 500, 502, 503, 504])('status %s maps to retryable', (status) => {
  expect(toProviderError(new ApiError({ message: 'boom', status })).retryable).toBe(true)
})

test.each([400, 401, 403, 404, 413, 422])('status %s maps to fatal', (status) => {
  expect(toProviderError(new ApiError({ message: 'boom', status })).retryable).toBe(false)
})

test('a 404 gains a hint about Gemini model ids', () => {
  const mapped = toProviderError(new ApiError({ message: 'model not found', status: 404 }))
  expect(mapped.message).toContain('model not found')
  expect(mapped.message).toContain('gemini-2.5-flash')
})

test('a non-404 keeps its message unchanged', () => {
  expect(toProviderError(new ApiError({ message: 'bad request', status: 400 })).message)
    .toBe('bad request')
})

test('an abort maps to a retryable 504 upstream_timeout', () => {
  const mapped = toProviderError(new DOMException('aborted', 'AbortError'))
  expect(mapped.status).toBe(504)
  expect(mapped.code).toBe('upstream_timeout')
  expect(mapped.retryable).toBe(true)
})

test('an unrecognised failure is a retryable 502', () => {
  const mapped = toProviderError(new Error('socket hang up'))
  expect(mapped.status).toBe(502)
  expect(mapped.code).toBe('upstream_error')
  expect(mapped.retryable).toBe(true)
})

test('an already-classified ProviderError passes through untouched', () => {
  const original = new ProviderError({ status: 429, message: 'slow down', retryable: true })
  expect(toProviderError(original)).toBe(original)
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run tests/lib/adapters/gemini/errors.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/gemini/errors`.

- [ ] **Step 4: Implement**

Create `src/lib/adapters/gemini/errors.ts`:

```ts
import { ApiError } from '@google/genai'
import { ProviderError } from '@/lib/gateway/errors'

// The same three statuses the OpenAI classifier treats as worth another
// provider: transport-ish rather than a rejection of the request, plus the one
// status where retrying elsewhere is exactly right.
const RETRYABLE_STATUSES = new Set([408, 409, 429])

// A 404 from Gemini is a model id it does not recognise, which is the single
// most likely mistake here: ids move fast, and a catalog synced weeks ago can
// name one that no longer exists.
const MODEL_HINT =
  'Gemini model ids look like "gemini-2.5-flash" — check the id on the Catalog page, or re-sync this provider.'

/**
 * Interprets a Gemini SDK failure so the routing loop does not have to. The
 * Gemini counterpart to `adapters/openai/errors.ts`, and separate from it for
 * the reason that file gives: only the adapter knows which of its provider's
 * statuses are worth retrying.
 */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err

  if (err instanceof ApiError) {
    // `status` is typed non-optional but is absent at runtime on some transport
    // failures the SDK still wraps as an ApiError.
    const status = err.status
    const retryable = !status || RETRYABLE_STATUSES.has(status) || status >= 500
    return new ProviderError({
      status: status || 502,
      code: null,
      message: status === 404 ? `${err.message}. ${MODEL_HINT}` : err.message,
      retryable,
    })
  }

  // DOMException does not extend Error on every runtime this may run on, so
  // both checks are needed to catch an abort.
  const isAbort =
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')

  return new ProviderError({
    status: isAbort ? 504 : 502,
    code: isAbort ? 'upstream_timeout' : 'upstream_error',
    message: err instanceof Error ? err.message : 'Upstream request failed',
    retryable: true,
  })
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run tests/lib/adapters/gemini/errors.test.ts`
Expected: PASS (18 tests — the two `test.each` blocks expand to 7 and 6).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add package.json pnpm-lock.yaml src/lib/adapters/gemini/errors.ts tests/lib/adapters/gemini/errors.test.ts
git commit -m "feat(gemini): classify Gemini API errors for the routing loop"
```

---

## Task 2: Request translation — messages to `contents`

**Files:**
- Create: `src/lib/translate/chat-to-gemini.ts`
- Test: `tests/lib/translate/chat-to-gemini-request.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `ChatCompletionRequest` from `@/lib/schemas/chat`; `Content`, `Part` types from `@google/genai`.
- Produces:
  - `export type MediaParts = Map<string, Part>`
  - `export function toContents(messages: ChatMessage[], media: MediaParts): { contents: Content[]; systemInstruction: string }`

Task 3 adds `toGeminiRequest` and `droppedParams` to this same file; Tasks 4 and 5 add the response and stream functions. Do not create them yet.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/translate/chat-to-gemini-request.test.ts`:

```ts
import { expect, test } from 'vitest'
import { toContents, type MediaParts } from '@/lib/translate/chat-to-gemini'
import type { ChatMessage } from '@/lib/schemas/chat'

const noMedia: MediaParts = new Map()

test('a plain exchange becomes alternating user and model turns', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ text: 'hello' }] },
    { role: 'user', parts: [{ text: 'again' }] },
  ])
})

test('system and developer turns are hoisted into the system instruction', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'developer', content: 'no emoji' },
  ]
  const { contents, systemInstruction } = toContents(messages, noMedia)

  expect(systemInstruction).toBe('be terse\n\nno emoji')
  expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
})

test('adjacent same-role turns are merged into one content', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
  ]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ text: 'one' }, { text: 'two' }] },
  ])
})

test('assistant tool calls become functionCall parts with parsed arguments', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      ],
    },
  ]
  expect(toContents(messages, noMedia).contents[1]).toEqual({
    role: 'model',
    parts: [{ functionCall: { id: 'call_a', name: 'get_weather', args: { city: 'Paris' } } }],
  })
})

test('unparseable tool call arguments degrade to an empty object', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: 'not json' } }],
    },
  ]
  expect(toContents(messages, noMedia).contents[0].parts?.[0])
    .toEqual({ functionCall: { id: 'call_a', name: 'f', args: {} } })
})

test('a tool result is correlated to its call name through the conversation', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_a', content: '{"temp":21}' },
  ]
  expect(toContents(messages, noMedia).contents[1]).toEqual({
    role: 'user',
    parts: [{ functionResponse: { id: 'call_a', name: 'get_weather', response: { temp: 21 } } }],
  })
})

test('a non-JSON tool result is wrapped under an output key', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'sunny' },
  ]
  expect(toContents(messages, noMedia).contents[1].parts?.[0])
    .toEqual({ functionResponse: { id: 'call_a', name: 'f', response: { output: 'sunny' } } })
})

test('a tool result whose call id matches nothing is carried as text', () => {
  const messages: ChatMessage[] = [{ role: 'tool', tool_call_id: 'call_missing', content: 'sunny' }]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ text: '[tool result] sunny' }] },
  ])
})

test('a tool result with no call id at all is carried as text', () => {
  const messages: ChatMessage[] = [{ role: 'tool', content: 'sunny' }]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ text: '[tool result] sunny' }] },
  ])
})

test('the legacy function role maps to a real functionResponse via its name', () => {
  const messages: ChatMessage[] = [{ role: 'function', name: 'get_weather', content: '{"temp":21}' }]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }] },
  ])
})

test('image parts are replaced by their resolved media part', () => {
  const media: MediaParts = new Map([
    ['https://example.com/cat.png', { fileData: { fileUri: 'files/abc', mimeType: 'image/png' } }],
  ])
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    },
  ]
  expect(toContents(messages, media).contents).toEqual([
    {
      role: 'user',
      parts: [
        { text: 'what is this' },
        { fileData: { fileUri: 'files/abc', mimeType: 'image/png' } },
      ],
    },
  ])
})

test('an image that could not be resolved is left out rather than failing', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'https://example.com/gone.png' } },
      ],
    },
  ]
  expect(toContents(messages, noMedia).contents).toEqual([
    { role: 'user', parts: [{ text: 'what is this' }] },
  ])
})

test('an empty message contributes no content at all', () => {
  expect(toContents([{ role: 'assistant', content: '' }], noMedia).contents).toEqual([])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/lib/translate/chat-to-gemini-request.test.ts`
Expected: FAIL — cannot resolve `@/lib/translate/chat-to-gemini`.

- [ ] **Step 3: Implement**

Create `src/lib/translate/chat-to-gemini.ts`:

```ts
import type { Content, Part } from '@google/genai'
import type { ChatMessage } from '@/lib/schemas/chat'

/**
 * Image parts already resolved to something Gemini accepts, keyed by the
 * client's original `image_url.url`. Built by `adapters/gemini/media.ts`,
 * because resolving one can mean a network fetch and an upload — the only I/O
 * this translation needs, and the reason it is done before translation rather
 * than during it. A url absent from the map could not be resolved; the part is
 * left out rather than failing the request.
 */
export type MediaParts = Map<string, Part>

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
}

function userParts(content: ChatMessage['content'], media: MediaParts): Part[] {
  if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : []
  if (!content) return []

  const parts: Part[] = []
  for (const part of content) {
    if (part.type === 'text') {
      const { text } = part as { text: string }
      if (text.length > 0) parts.push({ text })
    } else if (part.type === 'image_url') {
      const { url } = (part as { image_url: { url: string } }).image_url
      const resolved = media.get(url)
      if (resolved) parts.push(resolved)
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
  media: MediaParts,
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

    push('user', userParts(message.content, media))
  }

  return { contents, systemInstruction: system.join('\n\n') }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/lib/translate/chat-to-gemini-request.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/chat-to-gemini.ts tests/lib/translate/chat-to-gemini-request.test.ts
git commit -m "feat(gemini): translate chat messages into Gemini contents"
```

---

## Task 3: Request translation — config and dropped parameters

**Files:**
- Modify: `src/lib/translate/chat-to-gemini.ts` (append; do not touch `toContents`)
- Test: `tests/lib/translate/chat-to-gemini-config.test.ts`

**Interfaces:**
- Consumes: `toContents`, `MediaParts` from Task 2; `ProviderConfig` from `@/lib/adapters/types`.
- Produces:
  - `export function toGeminiRequest(req: ChatCompletionRequest, upstreamModel: string, media?: MediaParts, config?: ProviderConfig): GenerateContentParameters`
  - `export function droppedParams(req: ChatCompletionRequest): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/translate/chat-to-gemini-config.test.ts`:

```ts
import { expect, test } from 'vitest'
import { droppedParams, toGeminiRequest } from '@/lib/translate/chat-to-gemini'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

const base: ChatCompletionRequest = {
  model: 'virtual',
  messages: [{ role: 'user', content: 'hi' }],
}

function config(req: Partial<ChatCompletionRequest>) {
  return toGeminiRequest({ ...base, ...req }, 'gemini-2.5-flash').config ?? {}
}

test('the upstream model name replaces the virtual one', () => {
  expect(toGeminiRequest(base, 'gemini-2.5-flash').model).toBe('gemini-2.5-flash')
})

test('sampling parameters are renamed rather than dropped', () => {
  expect(config({
    temperature: 0.4,
    top_p: 0.9,
    seed: 7,
    stop: ['STOP'],
    max_tokens: 128,
  })).toMatchObject({
    temperature: 0.4,
    topP: 0.9,
    seed: 7,
    stopSequences: ['STOP'],
    maxOutputTokens: 128,
  })
})

test('max_completion_tokens wins over max_tokens', () => {
  expect(config({ max_tokens: 128, max_completion_tokens: 256 }).maxOutputTokens).toBe(256)
})

test('a bare string stop becomes a one-element stopSequences', () => {
  expect(config({ stop: 'END' }).stopSequences).toEqual(['END'])
})

test('penalties map to their camelCase names', () => {
  expect(config({ frequency_penalty: 0.5, presence_penalty: -0.2 } as Partial<ChatCompletionRequest>))
    .toMatchObject({ frequencyPenalty: 0.5, presencePenalty: -0.2 })
})

test('n of 1 sends no candidateCount at all', () => {
  expect(config({ n: 1 })).not.toHaveProperty('candidateCount')
})

test('n above 1 becomes candidateCount', () => {
  expect(config({ n: 3 }).candidateCount).toBe(3)
})

test('tools become function declarations with their JSON schema verbatim', () => {
  const parameters = { type: 'object', properties: { city: { type: 'string' } } }
  expect(config({
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters } }],
  }).tools).toEqual([{
    functionDeclarations: [{
      name: 'get_weather',
      description: 'weather',
      parametersJsonSchema: parameters,
    }],
  }])
})

test.each([
  ['none', 'NONE'],
  ['auto', 'AUTO'],
  ['required', 'ANY'],
] as const)('tool_choice %s maps to mode %s', (choice, mode) => {
  expect(config({ tool_choice: choice }).toolConfig)
    .toEqual({ functionCallingConfig: { mode } })
})

test('a named tool_choice constrains the allowed function names', () => {
  expect(config({ tool_choice: { type: 'function', function: { name: 'get_weather' } } }).toolConfig)
    .toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } })
})

test('json_object response format asks for a JSON mime type', () => {
  expect(config({ response_format: { type: 'json_object' } }).responseMimeType)
    .toBe('application/json')
})

test('json_schema response format carries the schema too', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
  expect(config({
    response_format: { type: 'json_schema', json_schema: { name: 'r', schema } },
  } as Partial<ChatCompletionRequest>)).toMatchObject({
    responseMimeType: 'application/json',
    responseJsonSchema: schema,
  })
})

test('a text response format asks for nothing', () => {
  expect(config({ response_format: { type: 'text' } })).not.toHaveProperty('responseMimeType')
})

test.each([
  ['minimal', 'MINIMAL'],
  ['low', 'LOW'],
  ['medium', 'MEDIUM'],
  ['high', 'HIGH'],
] as const)('reasoning_effort %s maps to thinking level %s', (effort, level) => {
  expect(config({ reasoning_effort: effort }).thinkingConfig)
    .toEqual({ includeThoughts: true, thinkingLevel: level })
})

test('no reasoning_effort means no thinking config', () => {
  expect(config({})).not.toHaveProperty('thinkingConfig')
})

test('an unknown reasoning_effort asks for no thinking config', () => {
  expect(config({ reasoning_effort: 'turbo' })).not.toHaveProperty('thinkingConfig')
})

test('requestReasoningSummary asks for thoughts without a level', () => {
  const result = toGeminiRequest(base, 'gemini-2.5-flash', new Map(), {
    requestReasoningSummary: true,
  })
  expect(result.config?.thinkingConfig).toEqual({ includeThoughts: true })
})

test('the system instruction reaches the config', () => {
  const result = toGeminiRequest(
    { ...base, messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }] },
    'gemini-2.5-flash',
  )
  expect(result.config?.systemInstruction).toBe('be terse')
})

test('a request with nothing to configure still carries contents', () => {
  const result = toGeminiRequest(base, 'gemini-2.5-flash')
  expect(result.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
})

test('unmappable parameters are reported', () => {
  expect(droppedParams({
    ...base,
    logit_bias: { '1': 2 },
    logprobs: true,
    top_logprobs: 3,
    parallel_tool_calls: false,
    user: 'u-1',
  } as ChatCompletionRequest).sort())
    .toEqual(['logit_bias', 'logprobs', 'parallel_tool_calls', 'top_logprobs', 'user'])
})

test('values that mean the default are not reported', () => {
  expect(droppedParams({
    ...base,
    logit_bias: {},
    logprobs: false,
    parallel_tool_calls: true,
    user: '',
  } as ChatCompletionRequest)).toEqual([])
})

test('a leading system message is not reported as hoisted', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }],
  })).toEqual([])
})

test('a system message after a user turn is reported as hoisted', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'be terse' }],
  })).toEqual(['system_message_hoisted'])
})

test('an uncorrelated tool result is reported', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'tool', tool_call_id: 'nope', content: 'x' }],
  })).toEqual(['unmatched_tool_call_id'])
})

test('malformed tool call arguments are reported', () => {
  expect(droppedParams({
    ...base,
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 'nope' } }],
    }],
  })).toEqual(['malformed_tool_arguments'])
})

test('a content part Gemini cannot carry is reported', () => {
  expect(droppedParams({
    ...base,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] }],
  } as ChatCompletionRequest)).toEqual(['unsupported_content_part'])
})

test('an unknown reasoning_effort is reported', () => {
  expect(droppedParams({ ...base, reasoning_effort: 'turbo' })).toEqual(['reasoning_effort'])
})

test('a known reasoning_effort is not reported', () => {
  expect(droppedParams({ ...base, reasoning_effort: 'high' })).toEqual([])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/lib/translate/chat-to-gemini-config.test.ts`
Expected: FAIL — `toGeminiRequest` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/translate/chat-to-gemini.ts`. Add these imports to the existing import block at the top of the file:

```ts
import {
  FunctionCallingConfigMode,
  ThinkingLevel,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type ToolConfig,
} from '@google/genai'
import type { ProviderConfig } from '@/lib/adapters/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
```

Note that `FunctionCallingConfigMode` and `ThinkingLevel` are imported as values, not types — they are string enums and are used as values below. `Content`, `Part` and `ChatMessage` are already imported from Task 2; merge rather than duplicate.

Then append:

```ts
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
  media: MediaParts = new Map(),
  config: ProviderConfig = {},
): GenerateContentParameters {
  const { contents, systemInstruction } = toContents(req.messages, media)
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
        m.content.some((part) => part.type !== 'text' && part.type !== 'image_url'),
    )
  ) {
    dropped.push('unsupported_content_part')
  }

  if (req.reasoning_effort && !THINKING_LEVELS[req.reasoning_effort]) {
    dropped.push('reasoning_effort')
  }

  return dropped
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/lib/translate/chat-to-gemini-config.test.ts`
Expected: PASS (33 tests — the two `test.each` blocks expand to 3 and 4).

- [ ] **Step 5: Run the whole translate suite to check Task 2 still passes**

Run: `pnpm vitest run tests/lib/translate`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/chat-to-gemini.ts tests/lib/translate/chat-to-gemini-config.test.ts
git commit -m "feat(gemini): map chat parameters onto the Gemini generation config"
```

---

## Task 4: Response translation

**Files:**
- Modify: `src/lib/translate/chat-to-gemini.ts` (append)
- Test: `tests/lib/translate/chat-to-gemini-response.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3's module.
- Produces:
  - `export function fromGenerateContent(res: GenerateContentResponse, model: string): ChatCompletion`
  - Internal, reused by Task 5 — export them so the stream translator in the same file can use them without duplication: `finishReasonFor`, `toUsage`, `synthesizedCallId`. Keep them module-private (Task 5 lives in the same file).

- [ ] **Step 1: Write the failing test**

Create `tests/lib/translate/chat-to-gemini-response.test.ts`:

```ts
import { expect, test } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import { fromGenerateContent } from '@/lib/translate/chat-to-gemini'

function response(partial: Partial<GenerateContentResponse>): GenerateContentResponse {
  return partial as GenerateContentResponse
}

test('text parts become the assistant message content', () => {
  const result = fromGenerateContent(
    response({
      responseId: 'resp-1',
      modelVersion: 'gemini-2.5-flash-001',
      candidates: [{
        content: { role: 'model', parts: [{ text: 'hello ' }, { text: 'world' }] },
        finishReason: 'STOP',
      }],
    }),
    'gemini-2.5-flash',
  )

  expect(result.model).toBe('gemini-2.5-flash-001')
  expect(result.choices[0].message.content).toBe('hello world')
  expect(result.choices[0].finish_reason).toBe('stop')
})

test('the upstream model name is used when the response does not name one', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
    'gemini-2.5-flash',
  )
  expect(result.model).toBe('gemini-2.5-flash')
})

test('thought parts become reasoning_content, not content', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{
        content: { parts: [{ text: 'thinking', thought: true }, { text: 'answer' }] },
        finishReason: 'STOP',
      }],
    }),
    'gemini-2.5-pro',
  )

  const message = result.choices[0].message as { content: string; reasoning_content?: string }
  expect(message.content).toBe('answer')
  expect(message.reasoning_content).toBe('thinking')
})

test('a text-free response reports null content rather than an empty string', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
    'gemini-2.5-flash',
  )
  expect(result.choices[0].message.content).toBeNull()
})

test('function calls become tool_calls and force a tool_calls finish reason', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        finishReason: 'STOP',
      }],
    }),
    'gemini-2.5-flash',
  )

  expect(result.choices[0].message.tool_calls).toEqual([{
    id: 'call_0_0',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
  }])
  expect(result.choices[0].finish_reason).toBe('tool_calls')
})

test('a function call id from the provider is preferred over a synthesized one', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{
        content: { parts: [{ functionCall: { id: 'upstream-1', name: 'f', args: {} } }] },
      }],
    }),
    'gemini-2.5-flash',
  )
  expect(result.choices[0].message.tool_calls?.[0].id).toBe('upstream-1')
})

test.each([
  ['MAX_TOKENS', 'length'],
  ['SAFETY', 'content_filter'],
  ['PROHIBITED_CONTENT', 'content_filter'],
  ['BLOCKLIST', 'content_filter'],
  ['SPII', 'content_filter'],
  ['IMAGE_SAFETY', 'content_filter'],
  ['RECITATION', 'content_filter'],
  ['STOP', 'stop'],
  ['OTHER', 'stop'],
  ['MALFORMED_FUNCTION_CALL', 'stop'],
] as const)('finish reason %s maps to %s', (reason, expected) => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }] }),
    'gemini-2.5-flash',
  )
  expect(result.choices[0].finish_reason).toBe(expected)
})

test('a blocked prompt becomes one empty content_filter choice, not an error', () => {
  const result = fromGenerateContent(
    response({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    'gemini-2.5-flash',
  )

  expect(result.choices).toHaveLength(1)
  expect(result.choices[0].message.content).toBeNull()
  expect(result.choices[0].finish_reason).toBe('content_filter')
})

test('multiple candidates become multiple choices at their own indices', () => {
  const result = fromGenerateContent(
    response({
      candidates: [
        { index: 0, content: { parts: [{ text: 'one' }] }, finishReason: 'STOP' },
        { index: 1, content: { parts: [{ text: 'two' }] }, finishReason: 'STOP' },
      ],
    }),
    'gemini-2.5-flash',
  )

  expect(result.choices.map((c) => [c.index, c.message.content]))
    .toEqual([[0, 'one'], [1, 'two']])
})

test('completion tokens include thoughts, which are also reported separately', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 6,
        totalTokenCount: 20,
        cachedContentTokenCount: 3,
      },
    }),
    'gemini-2.5-pro',
  )

  expect(result.usage).toMatchObject({
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    completion_tokens_details: { reasoning_tokens: 6 },
    prompt_tokens_details: { cached_tokens: 3 },
  })
})

test('usage with no thoughts reports no reasoning token details', () => {
  const result = fromGenerateContent(
    response({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    }),
    'gemini-2.5-flash',
  )

  expect(result.usage?.completion_tokens).toBe(3)
  expect(result.usage).not.toHaveProperty('completion_tokens_details')
})

test('a response with no usage metadata reports no usage', () => {
  const result = fromGenerateContent(
    response({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
    'gemini-2.5-flash',
  )
  expect(result.usage).toBeUndefined()
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/lib/translate/chat-to-gemini-response.test.ts`
Expected: FAIL — `fromGenerateContent` is not exported.

- [ ] **Step 3: Implement**

Add to the `@google/genai` import block: `type Candidate`, `type GenerateContentResponse`, `type GenerateContentResponseUsageMetadata`. Add to the top-level imports:

```ts
import type { ChatCompletion, ChatCompletionChunk } from '@/lib/adapters/types'
```

`ChatCompletionChunk` is unused until Task 5; add it now so the import block is edited once.

Append to `src/lib/translate/chat-to-gemini.ts`:

```ts
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
  if (hasToolCalls) return 'tool_calls'
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason && CONTENT_FILTER_REASONS.has(reason)) return 'content_filter'
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
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/lib/translate/chat-to-gemini-response.test.ts`
Expected: PASS (21 tests — the finish-reason `test.each` expands to 10).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/chat-to-gemini.ts tests/lib/translate/chat-to-gemini-response.test.ts
git commit -m "feat(gemini): translate a Gemini response into a chat completion"
```

---

## Task 5: Stream translation

**Files:**
- Modify: `src/lib/translate/chat-to-gemini.ts` (append)
- Test: `tests/lib/translate/chat-to-gemini-stream.test.ts`

**Interfaces:**
- Consumes: `finishReasonFor`, `toUsage`, `synthesizedCallId`, `createdAt` from Task 4 (same file, module-private).
- Produces: `export async function* fromGenerateContentStream(chunks: AsyncIterable<GenerateContentResponse>, req: ChatCompletionRequest, model: string): AsyncIterable<ChatCompletionChunk>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/translate/chat-to-gemini-stream.test.ts`:

```ts
import { expect, test } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import { fromGenerateContentStream } from '@/lib/translate/chat-to-gemini'
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

const req: ChatCompletionRequest = {
  model: 'virtual',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
}

async function* source(...responses: Partial<GenerateContentResponse>[]) {
  for (const response of responses) yield response as GenerateContentResponse
}

async function collect(
  stream: AsyncIterable<ChatCompletionChunk>,
): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('text deltas become content deltas, with the role on the first one', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source(
      { candidates: [{ content: { parts: [{ text: 'he' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'llo' }] } }] },
    ),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'he' })
  expect(chunks[1].choices[0].delta).toEqual({ content: 'llo' })
})

test('the model version from the stream replaces the fallback', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      modelVersion: 'gemini-2.5-flash-001',
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    }),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks[0].model).toBe('gemini-2.5-flash-001')
})

test('thought parts stream as reasoning_content', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }),
    req,
    'gemini-2.5-pro',
  ))

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', reasoning_content: 'hmm' })
})

test('a function call arrives as one complete tool_calls fragment', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] } }],
    }),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks[0].choices[0].delta.tool_calls).toEqual([{
    index: 0,
    id: 'call_0_0',
    type: 'function',
    function: { name: 'f', arguments: '{"a":1}' },
  }])
})

test('a finish reason is emitted on its own chunk', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source(
      { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      { candidates: [{ finishReason: 'STOP' }] },
    ),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks.at(-1)?.choices[0]).toMatchObject({ delta: {}, finish_reason: 'stop' })
})

test('a stream that produced tool calls finishes as tool_calls', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source(
      { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] } }] },
      { candidates: [{ finishReason: 'STOP' }] },
    ),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('tool_calls')
})

test('usage rides a final choices-empty chunk', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source(
      { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      },
    ),
    req,
    'gemini-2.5-flash',
  ))

  const last = chunks.at(-1)
  expect(last?.choices).toEqual([])
  expect(last?.usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
})

test('include_usage false suppresses the usage chunk', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    }),
    { ...req, stream_options: { include_usage: false } },
    'gemini-2.5-flash',
  ))

  expect(chunks.every((chunk) => chunk.usage === undefined)).toBe(true)
})

test('a blocked prompt ends the stream with a content_filter finish', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    req,
    'gemini-2.5-flash',
  ))

  expect(chunks).toHaveLength(1)
  expect(chunks[0].choices[0].finish_reason).toBe('content_filter')
})

test('candidates keep their own choice index when n is above 1', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      candidates: [
        { index: 0, content: { parts: [{ text: 'one' }] } },
        { index: 1, content: { parts: [{ text: 'two' }] } },
      ],
    }),
    { ...req, n: 2 },
    'gemini-2.5-flash',
  ))

  expect(chunks.map((c) => [c.choices[0].index, c.choices[0].delta.content]))
    .toEqual([[0, 'one'], [1, 'two']])
})

test('each choice gets its own role chunk', async () => {
  const chunks = await collect(fromGenerateContentStream(
    source({
      candidates: [
        { index: 0, content: { parts: [{ text: 'one' }] } },
        { index: 1, content: { parts: [{ text: 'two' }] } },
      ],
    }),
    { ...req, n: 2 },
    'gemini-2.5-flash',
  ))

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'one' })
  expect(chunks[1].choices[0].delta).toEqual({ role: 'assistant', content: 'two' })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/lib/translate/chat-to-gemini-stream.test.ts`
Expected: FAIL — `fromGenerateContentStream` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/translate/chat-to-gemini.ts`:

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/lib/translate/chat-to-gemini-stream.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/translate/chat-to-gemini.ts tests/lib/translate/chat-to-gemini-stream.test.ts
git commit -m "feat(gemini): translate a Gemini stream into chat completion chunks"
```

---

## Task 6: Media resolution

**Files:**
- Create: `src/lib/adapters/gemini/media.ts`
- Test: `tests/lib/adapters/gemini/media.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `@/lib/schemas/chat`; `MediaParts` from `@/lib/translate/chat-to-gemini`.
- Produces:
  - `export interface MediaDeps { client: Pick<GoogleGenAI, 'files'>; signal: AbortSignal; requestId: string; fetchImpl?: typeof fetch; maxBytes?: number }`
  - `export function imageUrls(messages: ChatMessage[]): string[]`
  - `export async function resolveMedia(messages: ChatMessage[], deps: MediaDeps): Promise<MediaParts>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/adapters/gemini/media.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { imageUrls, resolveMedia, type MediaDeps } from '@/lib/adapters/gemini/media'
import type { ChatMessage } from '@/lib/schemas/chat'

function imageMessage(...urls: string[]): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      ...urls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ],
  }
}

function imageResponse(body: Uint8Array, type = 'image/png') {
  return new Response(body, { status: 200, headers: { 'content-type': type } })
}

function deps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return {
    client: { files: { upload: vi.fn().mockResolvedValue({ uri: 'files/abc', mimeType: 'image/png' }) } } as never,
    signal: new AbortController().signal,
    requestId: 'req_1',
    fetchImpl: vi.fn().mockResolvedValue(imageResponse(new Uint8Array([1, 2, 3]))),
    ...overrides,
  }
}

test('image urls are collected once each, in order', () => {
  const messages = [imageMessage('a', 'b'), imageMessage('a')]
  expect(imageUrls(messages)).toEqual(['a', 'b'])
})

test('a message with no array content contributes no urls', () => {
  expect(imageUrls([{ role: 'user', content: 'hi' }])).toEqual([])
})

test('a base64 data uri becomes inline data with no network call', async () => {
  const d = deps()
  const resolved = await resolveMedia([imageMessage('data:image/png;base64,AQID')], d)

  expect(resolved.get('data:image/png;base64,AQID'))
    .toEqual({ inlineData: { mimeType: 'image/png', data: 'AQID' } })
  expect(d.fetchImpl).not.toHaveBeenCalled()
})

test('a files api url passes straight through as file data', async () => {
  const url = 'https://generativelanguage.googleapis.com/v1beta/files/abc'
  const d = deps()
  const resolved = await resolveMedia([imageMessage(url)], d)

  expect(resolved.get(url)).toEqual({ fileData: { fileUri: url } })
  expect(d.fetchImpl).not.toHaveBeenCalled()
})

test('a gs uri passes straight through as file data', async () => {
  const d = deps()
  const resolved = await resolveMedia([imageMessage('gs://bucket/cat.png')], d)
  expect(resolved.get('gs://bucket/cat.png')).toEqual({ fileData: { fileUri: 'gs://bucket/cat.png' } })
})

test('an https image is fetched, uploaded, and referenced by its uri', async () => {
  const upload = vi.fn().mockResolvedValue({ uri: 'files/xyz', mimeType: 'image/png' })
  const d = deps({ client: { files: { upload } } as never })
  const resolved = await resolveMedia([imageMessage('https://example.com/cat.png')], d)

  expect(d.fetchImpl).toHaveBeenCalledWith(
    'https://example.com/cat.png',
    expect.objectContaining({ signal: d.signal }),
  )
  expect(upload).toHaveBeenCalledWith(expect.objectContaining({
    config: expect.objectContaining({ mimeType: 'image/png', abortSignal: d.signal }),
  }))
  expect(resolved.get('https://example.com/cat.png'))
    .toEqual({ fileData: { fileUri: 'files/xyz', mimeType: 'image/png' } })
})

test('the same url is fetched and uploaded only once', async () => {
  const upload = vi.fn().mockResolvedValue({ uri: 'files/xyz', mimeType: 'image/png' })
  const d = deps({ client: { files: { upload } } as never })
  await resolveMedia([imageMessage('https://example.com/cat.png', 'https://example.com/cat.png')], d)

  expect(d.fetchImpl).toHaveBeenCalledTimes(1)
  expect(upload).toHaveBeenCalledTimes(1)
})

test('a failed fetch drops the image and warns rather than throwing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps({ fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 404 })) })

  const resolved = await resolveMedia([imageMessage('https://example.com/gone.png')], d)

  expect(resolved.size).toBe(0)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('req_1'))
  warn.mockRestore()
})

test('a non-image response is refused', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps({
    fetchImpl: vi.fn().mockResolvedValue(
      new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ),
  })

  expect((await resolveMedia([imageMessage('https://example.com/page')], d)).size).toBe(0)
  warn.mockRestore()
})

test('an image over the byte cap is refused', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps({
    maxBytes: 2,
    fetchImpl: vi.fn().mockResolvedValue(imageResponse(new Uint8Array([1, 2, 3, 4]))),
  })

  expect((await resolveMedia([imageMessage('https://example.com/big.png')], d)).size).toBe(0)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('byte'))
  warn.mockRestore()
})

test('an upload that returns no uri is refused', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const d = deps({ client: { files: { upload: vi.fn().mockResolvedValue({}) } } as never })

  expect((await resolveMedia([imageMessage('https://example.com/cat.png')], d)).size).toBe(0)
  warn.mockRestore()
})

test('a request with no images does no work at all', async () => {
  const d = deps()
  expect((await resolveMedia([{ role: 'user', content: 'hi' }], d)).size).toBe(0)
  expect(d.fetchImpl).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/lib/adapters/gemini/media.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/gemini/media`.

- [ ] **Step 3: Implement**

Create `src/lib/adapters/gemini/media.ts`:

```ts
import type { GoogleGenAI, Part } from '@google/genai'
import type { ChatMessage } from '@/lib/schemas/chat'
import type { MediaParts } from '@/lib/translate/chat-to-gemini'

/** Gemini's own inline request limit, which an upload body should not exceed. */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

/** URIs Gemini already accepts by reference, so they need no upload. */
const FILE_URI = /^(gs:\/\/|https:\/\/generativelanguage\.googleapis\.com\/)/

const DATA_URI = /^data:([^;,]+)(;base64)?,(.*)$/s

export interface MediaDeps {
  client: Pick<GoogleGenAI, 'files'>
  signal: AbortSignal
  requestId: string
  /** Injected by tests; production passes nothing and gets global fetch. */
  fetchImpl?: typeof fetch
  maxBytes?: number
}

/** Every distinct image url in the request, in first-seen order. */
export function imageUrls(messages: ChatMessage[]): string[] {
  const urls: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'image_url') continue
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url
      if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) urls.push(url)
    }
  }
  return urls
}

function inlinePart(url: string): Part | null {
  const match = DATA_URI.exec(url)
  if (!match) return null

  const [, mimeType, base64, payload] = match
  const data = base64
    ? payload
    : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64')

  return { inlineData: { mimeType, data } }
}

/**
 * Reads the body while counting, rather than trusting Content-Length: a server
 * that lies about it — or omits it — would otherwise let an unbounded body into
 * memory.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('the image response carried no body')

  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`the image is over the ${maxBytes} byte limit`)
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function uploadedPart(url: string, deps: MediaDeps): Promise<Part> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(url, { signal: deps.signal })
  if (!res.ok) throw new Error(`fetching it returned ${res.status}`)

  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!mimeType.startsWith('image/')) {
    throw new Error(`expected an image, got "${mimeType || 'no content type'}"`)
  }

  const body = await readCapped(res, deps.maxBytes ?? DEFAULT_MAX_BYTES)

  const file = await deps.client.files.upload({
    file: new Blob([body as BlobPart], { type: mimeType }),
    config: { mimeType, abortSignal: deps.signal },
  })

  // Images come back ACTIVE immediately, so `file.state` is not polled; the
  // wait would only pay off for the video and audio inputs this ingress cannot
  // carry anyway.
  if (!file.uri) throw new Error('the upload returned no file uri')

  return { fileData: { fileUri: file.uri, mimeType: file.mimeType ?? mimeType } }
}

function warn(requestId: string, url: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err)
  console.warn(`[gemini] request_id=${requestId} dropped image ${url}: ${reason}`)
}

/**
 * Resolves every image in a request to something Gemini accepts, before any
 * translation runs. This is the only I/O on the translation path, and it lives
 * here precisely so `chat-to-gemini.ts` can stay pure and synchronous.
 *
 * A url that cannot be resolved is left out of the map, which the translator
 * reads as "omit this part". Failing the whole request over one unreachable
 * image would contradict the compatibility stance the layer is built on. It is
 * logged rather than reported through `x-babellm-dropped-params`, because that
 * header is computed from the request body before any attempt runs.
 *
 * Resolution is sequential rather than concurrent: a request carrying enough
 * images for that to matter is already the exception, and serial failures
 * produce log lines in a stable order.
 */
export async function resolveMedia(
  messages: ChatMessage[],
  deps: MediaDeps,
): Promise<MediaParts> {
  const resolved: MediaParts = new Map()

  for (const url of imageUrls(messages)) {
    if (url.startsWith('data:')) {
      const part = inlinePart(url)
      if (part) resolved.set(url, part)
      else warn(deps.requestId, url, new Error('the data: URI could not be parsed'))
      continue
    }

    if (FILE_URI.test(url)) {
      resolved.set(url, { fileData: { fileUri: url } })
      continue
    }

    try {
      resolved.set(url, await uploadedPart(url, deps))
    } catch (err) {
      warn(deps.requestId, url, err)
    }
  }

  return resolved
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/lib/adapters/gemini/media.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/adapters/gemini/media.ts tests/lib/adapters/gemini/media.test.ts
git commit -m "feat(gemini): resolve chat image parts into Gemini parts"
```

---

## Task 7: Client construction and model discovery

**Files:**
- Create: `src/lib/adapters/gemini/client.ts`
- Test: `tests/lib/adapters/gemini/models.test.ts`

**Interfaces:**
- Consumes: `ProviderRuntime`, `DiscoveredModel`, `ListModelsContext` from `../types`; `CatalogFields` from `@/lib/catalog/types`.
- Produces:
  - `export type GeminiClientFactory = (opts: GoogleGenAIOptions) => GoogleGenAI`
  - `export function createGeminiClient(runtime: ProviderRuntime, factory?: GeminiClientFactory): GoogleGenAI`
  - `export function catalogFields(model: Model): CatalogFields`
  - `export async function listModels(client: GoogleGenAI, ctx: ListModelsContext): Promise<DiscoveredModel[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/adapters/gemini/models.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { catalogFields, createGeminiClient, listModels } from '@/lib/adapters/gemini/client'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'gemini-prod',
  adapter: 'gemini',
  baseUrl: null,
  credentials: { apiKey: 'g-key' },
  config: {},
  apiFlavor: 'chat_completions',
}

const ctx = { signal: new AbortController().signal }

async function* pager(...models: unknown[]) {
  for (const model of models) yield model
}

function fakeClient(...models: unknown[]) {
  const list = vi.fn().mockResolvedValue(pager(...models))
  return { models: { list } } as never
}

test('the client is built from the api key', () => {
  const factory = vi.fn().mockReturnValue({})
  createGeminiClient(runtime, factory)
  expect(factory).toHaveBeenCalledWith({ apiKey: 'g-key' })
})

test('a stored base url is passed as an http option', () => {
  const factory = vi.fn().mockReturnValue({})
  createGeminiClient({ ...runtime, baseUrl: 'https://proxy.internal' }, factory)
  expect(factory).toHaveBeenCalledWith({
    apiKey: 'g-key',
    httpOptions: { baseUrl: 'https://proxy.internal' },
  })
})

test('a missing api key fails loudly and names the provider', () => {
  expect(() => createGeminiClient({ ...runtime, credentials: {} }, vi.fn()))
    .toThrow(/gemini-prod/)
})

test('never asks for Vertex', () => {
  const factory = vi.fn().mockReturnValue({})
  createGeminiClient(runtime, factory)
  expect(factory.mock.calls[0][0]).not.toHaveProperty('vertexai')
})

test('token limits and actions become catalog fields', () => {
  expect(catalogFields({
    name: 'models/gemini-2.5-flash',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedActions: ['generateContent', 'streamGenerateContent'],
  })).toEqual({
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    kind: 'chat',
  })
})

test('an embedding model is classified as one', () => {
  expect(catalogFields({
    name: 'models/text-embedding-004',
    supportedActions: ['embedContent'],
  })).toMatchObject({ kind: 'embedding', supportsStreaming: false })
})

test('a model reporting nothing contributes nothing', () => {
  expect(catalogFields({ name: 'models/mystery' })).toEqual({})
})

test('discovered ids drop the models/ prefix', async () => {
  const models = await listModels(
    fakeClient({ name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] }),
    ctx,
  )
  expect(models[0].id).toBe('gemini-2.5-flash')
})

test('discovery asks for base models and threads the signal', async () => {
  const client = fakeClient({ name: 'models/gemini-2.5-flash' })
  await listModels(client, ctx)

  expect((client as unknown as { models: { list: ReturnType<typeof vi.fn> } }).models.list)
    .toHaveBeenCalledWith({ config: { queryBase: true, abortSignal: ctx.signal } })
})

test('a nameless entry is skipped rather than stored', async () => {
  const models = await listModels(fakeClient({}, { name: 'models/ok' }), ctx)
  expect(models.map((m) => m.id)).toEqual(['ok'])
})

test('the raw entry is kept for debugging', async () => {
  const entry = { name: 'models/gemini-2.5-flash' }
  const models = await listModels(fakeClient(entry), ctx)
  expect(models[0].raw).toBe(entry)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/lib/adapters/gemini/models.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/gemini/client`.

- [ ] **Step 3: Implement**

Create `src/lib/adapters/gemini/client.ts`:

```ts
import { GoogleGenAI, type GoogleGenAIOptions, type Model } from '@google/genai'
import type { CatalogFields } from '@/lib/catalog/types'
import type { DiscoveredModel, ListModelsContext, ProviderRuntime } from '../types'

export type GeminiClientFactory = (opts: GoogleGenAIOptions) => GoogleGenAI

const defaultFactory: GeminiClientFactory = (opts) => new GoogleGenAI(opts)

interface GeminiCredentials {
  apiKey?: string
}

/**
 * The Gemini Developer API, always: `vertexai`, `project` and `location` are
 * never set, because Vertex needs service-account OAuth rather than the api key
 * this provider's credential schema stores.
 *
 * `baseUrl` is honoured when a provider carries one so a proxy can be pointed
 * at, but the provider form does not offer it — nothing in the UI implies a
 * Gemini provider is configurable that way.
 */
export function createGeminiClient(
  runtime: ProviderRuntime,
  factory: GeminiClientFactory = defaultFactory,
): GoogleGenAI {
  const credentials = runtime.credentials as GeminiCredentials
  if (!credentials.apiKey) {
    throw new Error(`Provider "${runtime.name}" is missing an apiKey credential.`)
  }

  return factory({
    apiKey: credentials.apiKey,
    ...(runtime.baseUrl ? { httpOptions: { baseUrl: runtime.baseUrl } } : {}),
  })
}

/**
 * What Gemini reports about a model that the catalog can actually use. This is
 * the first adapter to fill the `discovered` layer with anything: `/v1/models`
 * on an OpenAI-shaped provider reports an id and nothing else.
 *
 * A field is left absent rather than nulled when Gemini does not report it,
 * because the merge layer reads absent as "this layer does not know" and null
 * as an answer.
 */
export function catalogFields(model: Model): CatalogFields {
  const actions = model.supportedActions ?? []
  const fields: CatalogFields = {}

  if (typeof model.inputTokenLimit === 'number') fields.contextWindow = model.inputTokenLimit
  if (typeof model.outputTokenLimit === 'number') fields.maxOutputTokens = model.outputTokenLimit

  if (actions.length > 0) {
    fields.supportsStreaming = actions.includes('streamGenerateContent')
    if (actions.includes('generateContent')) fields.kind = 'chat'
    else if (actions.includes('embedContent')) fields.kind = 'embedding'
  }

  return fields
}

/**
 * `queryBase: true` is load-bearing: without it the SDK lists this key's *tuned*
 * models rather than the base catalog, so a sync would come back empty for
 * nearly every account.
 */
export async function listModels(
  client: GoogleGenAI,
  ctx: ListModelsContext,
): Promise<DiscoveredModel[]> {
  const pager = await client.models.list({
    config: { queryBase: true, abortSignal: ctx.signal },
  })

  const models: DiscoveredModel[] = []
  for await (const model of pager) {
    if (typeof model.name !== 'string' || model.name.length === 0) continue
    // Stored without the prefix so direct addressing reads
    // `google/gemini-2.5-flash`. canonicalKeyCandidates already tries both
    // forms, so a hand-entered prefixed id still matches models.dev.
    models.push({
      id: model.name.replace(/^models\//, ''),
      fields: catalogFields(model),
      raw: model,
    })
  }

  return models
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/lib/adapters/gemini/models.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/adapters/gemini/client.ts tests/lib/adapters/gemini/models.test.ts
git commit -m "feat(gemini): build the client and discover models with catalog fields"
```

---

## Task 8: The adapter, and its registration

**Files:**
- Create: `src/lib/adapters/gemini/index.ts`
- Modify: `src/lib/adapters/registry.ts:57-62`
- Modify: `tests/lib/adapters/registry.test.ts:95`
- Modify: `tests/gateway/chat.test.ts:124-135`
- Test: `tests/lib/adapters/gemini/chat.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 4–7.
- Produces: `export function createGeminiAdapter(runtime: ProviderRuntime, createClient?: GeminiClientFactory): ProviderAdapter`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/adapters/gemini/chat.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { createGeminiAdapter } from '@/lib/adapters/gemini'
import type { ProviderRuntime } from '@/lib/adapters/types'
import { ProviderError } from '@/lib/gateway/errors'
import { ApiError } from '@google/genai'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'gemini-prod',
  adapter: 'gemini',
  baseUrl: null,
  credentials: { apiKey: 'g-key' },
  config: {},
  apiFlavor: 'chat_completions',
}

const ctx = {
  upstreamModel: 'gemini-2.5-flash',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const answer = {
  candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
}

async function* oneChunk() {
  yield { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const generateContent = vi.fn().mockResolvedValue(answer)
  const generateContentStream = vi.fn().mockResolvedValue(oneChunk())
  const client = {
    models: { generateContent, generateContentStream, list: vi.fn() },
    files: { upload: vi.fn() },
    ...overrides,
  }
  return { client, generateContent, generateContentStream, factory: vi.fn().mockReturnValue(client) }
}

test('a chat request is translated, sent, and translated back', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  const result = await adapter.chat(
    { model: 'virtual', messages: [{ role: 'user', content: 'hi' }] },
    ctx,
  )

  expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  }))
  expect(result.choices[0].message.content).toBe('hi')
  expect(result.usage?.total_tokens).toBe(3)
})

test('the abort signal reaches the upstream call', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  await adapter.chat({ model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }, ctx)

  expect(generateContent.mock.calls[0][0].config.abortSignal).toBe(ctx.signal)
})

test('the provider config reaches the translator', async () => {
  const { generateContent, factory } = fakeClient()
  const adapter = createGeminiAdapter(
    { ...runtime, config: { requestReasoningSummary: true } },
    factory as never,
  )

  await adapter.chat({ model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }, ctx)

  expect(generateContent.mock.calls[0][0].config.thinkingConfig)
    .toEqual({ includeThoughts: true })
})

test('an upstream failure arrives already classified', async () => {
  const { factory } = fakeClient({
    models: {
      generateContent: vi.fn().mockRejectedValue(new ApiError({ message: 'nope', status: 400 })),
      generateContentStream: vi.fn(),
      list: vi.fn(),
    },
  })
  const adapter = createGeminiAdapter(runtime, factory as never)

  const error = await adapter
    .chat({ model: 'virtual', messages: [{ role: 'user', content: 'hi' }] }, ctx)
    .catch((err: unknown) => err)

  expect(error).toBeInstanceOf(ProviderError)
  expect((error as ProviderError).retryable).toBe(false)
})

test('a stream is translated chunk by chunk', async () => {
  const { generateContentStream, factory } = fakeClient()
  const adapter = createGeminiAdapter(runtime, factory as never)

  const chunks = []
  for await (const chunk of adapter.chatStream(
    { model: 'virtual', messages: [{ role: 'user', content: 'hi' }], stream: true },
    ctx,
  )) {
    chunks.push(chunk)
  }

  expect(generateContentStream.mock.calls[0][0].config.abortSignal).toBe(ctx.signal)
  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'hi' })
})

test('a failure while opening a stream arrives classified', async () => {
  const { factory } = fakeClient({
    models: {
      generateContent: vi.fn(),
      generateContentStream: vi.fn().mockRejectedValue(new ApiError({ message: 'slow', status: 429 })),
      list: vi.fn(),
    },
  })
  const adapter = createGeminiAdapter(runtime, factory as never)

  const iterator = adapter.chatStream(
    { model: 'virtual', messages: [{ role: 'user', content: 'hi' }], stream: true },
    ctx,
  )[Symbol.asyncIterator]()

  const error = await iterator.next().catch((err: unknown) => err)
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as ProviderError).retryable).toBe(true)
})

test('a failure while draining a stream arrives classified', async () => {
  async function* failing() {
    yield { candidates: [{ content: { parts: [{ text: 'hi' }] } }] }
    throw new ApiError({ message: 'cut off', status: 503 })
  }
  const { factory } = fakeClient({
    models: {
      generateContent: vi.fn(),
      generateContentStream: vi.fn().mockResolvedValue(failing()),
      list: vi.fn(),
    },
  })
  const adapter = createGeminiAdapter(runtime, factory as never)

  const error = await (async () => {
    try {
      for await (const _ of adapter.chatStream(
        { model: 'virtual', messages: [{ role: 'user', content: 'hi' }], stream: true },
        ctx,
      )) { /* drain */ }
    } catch (err) {
      return err
    }
  })()

  expect(error).toBeInstanceOf(ProviderError)
})

test('images are resolved before the request is built', async () => {
  const upload = vi.fn().mockResolvedValue({ uri: 'files/abc', mimeType: 'image/png' })
  const { generateContent, factory } = fakeClient({ files: { upload } })
  const adapter = createGeminiAdapter(runtime, factory as never)

  await adapter.chat({
    model: 'virtual',
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }],
    }],
  }, ctx)

  expect(generateContent.mock.calls[0][0].contents[0].parts[0])
    .toEqual({ inlineData: { mimeType: 'image/png', data: 'AQID' } })
  expect(upload).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/lib/adapters/gemini/chat.test.ts`
Expected: FAIL — cannot resolve `@/lib/adapters/gemini`.

- [ ] **Step 3: Implement the adapter**

Create `src/lib/adapters/gemini/index.ts`:

```ts
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'
import {
  fromGenerateContent,
  fromGenerateContentStream,
  toGeminiRequest,
} from '@/lib/translate/chat-to-gemini'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'
import { createGeminiClient, listModels, type GeminiClientFactory } from './client'
import { toProviderError } from './errors'
import { resolveMedia } from './media'

// Re-exported because tests and the registry import the factory type from the
// adapter module rather than reaching past it.
export type { GeminiClientFactory }

/**
 * A provider that speaks Google's generateContent API. It holds no translation
 * logic of its own — that lives in the pure module, which is what makes it
 * testable without a client — and satisfies the same ProviderAdapter contract
 * as the OpenAI-shaped adapters, so the routing loop never learns that a third
 * protocol exists.
 */
export function createGeminiAdapter(
  runtime: ProviderRuntime,
  createClient?: GeminiClientFactory,
): ProviderAdapter {
  const client = createGeminiClient(runtime, createClient)

  /**
   * Media resolution is the one part of building a request that does I/O, so it
   * happens here rather than inside the translator, which stays pure.
   */
  async function upstreamParams(
    req: ChatCompletionRequest,
    ctx: AttemptContext,
  ): Promise<GenerateContentParameters> {
    const media = await resolveMedia(req.messages, {
      client,
      signal: ctx.signal,
      requestId: ctx.requestId,
    })
    const params = toGeminiRequest(req, ctx.upstreamModel, media, runtime.config)
    return { ...params, config: { ...params.config, abortSignal: ctx.signal } }
  }

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      try {
        const result = await client.models.generateContent(await upstreamParams(req, ctx))
        return fromGenerateContent(result, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err)
      }
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway has
      // committed a response, the second after. Both must arrive at the routing
      // loop already interpreted.
      let stream: AsyncGenerator<GenerateContentResponse>
      try {
        stream = await client.models.generateContentStream(await upstreamParams(req, ctx))
      } catch (err) {
        throw toProviderError(err)
      }

      try {
        yield* fromGenerateContentStream(stream, req, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err)
      }
    },

    listModels: (ctx) => listModels(client, ctx),
  }
}
```

- [ ] **Step 4: Run the adapter test**

Run: `pnpm vitest run tests/lib/adapters/gemini/chat.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Register the adapter**

In `src/lib/adapters/registry.ts`, add the import beside the existing adapter imports:

```ts
import { createGeminiAdapter } from './gemini'
```

Then replace the combined `gemini`/`bedrock` case:

```ts
    case 'gemini':
      return createGeminiAdapter(runtime)
    case 'bedrock':
      throw new UnsupportedOperationError(
        `The "${runtime.adapter}" adapter is not available yet.`,
      )
```

- [ ] **Step 6: Move the "unimplemented" assertions to bedrock**

Three existing tests assert Gemini is unimplemented. All three keep testing the same thing
— an adapter type the registry cannot construct — against `bedrock`.

In `tests/lib/adapters/registry.test.ts`, replace the parameterised case:

```ts
test('bedrock is not yet implemented', () => {
  expect(() => createAdapter(provider({ adapter: 'bedrock' }))).toThrow(UnsupportedOperationError)
})

test('gemini gets a real adapter', () => {
  const adapter = createAdapter(
    provider({ adapter: 'gemini', credentials: { apiKey: 'g-key' } }),
  )
  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.listModels).toBe('function')
})
```

`provider()` is the row helper that file already defines — read it before writing, since it
encrypts `credentials` and you must pass the plain object it expects.

In `tests/gateway/chat.test.ts`, the test at line 124 seeds
`seedGateway({ adapter: 'gemini', credentials: { apiKey: 'g-key' } })`. Change it to:

```ts
test('a bedrock target returns 501 unsupported_operation instead of an opaque 500', async () => {
```

with the seed becoming
`seedGateway({ adapter: 'bedrock', credentials: { region: 'us-east-1', useInstanceRole: true } })`.
Leave the explanatory comment inside the test intact — the regression it documents is about
how the handler wraps `deps.createAdapter`, which has not changed.

- [ ] **Step 7: Repoint the direct-addressing test**

`tests/gateway/direct-model.test.ts` line 95, "answers 501 for a direct address on a
provider with no adapter", calls `seedCatalogOnly('gemini')` and deliberately uses the real
registry. It must move to bedrock or it will now get a 200.

Widen the helper's parameter type at line 20:

```ts
async function seedCatalogOnly(
  adapter: 'openai_compatible' | 'gemini' | 'bedrock' = 'openai_compatible',
) {
```

and change the call at line 96 to `seedCatalogOnly('bedrock')`. The helper inserts rows
directly without credential validation, and `createAdapter` throws for bedrock before
reading credentials, so the seeded `{ apiKey: 'sk-upstream' }` needs no change.

Run: `pnpm vitest run tests/gateway/direct-model.test.ts tests/gateway/chat.test.ts tests/lib/adapters/registry.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the whole suite**

Run: `pnpm test`
Expected: PASS, with a higher count than the 536 baseline and no failures.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/adapters/gemini/index.ts src/lib/adapters/registry.ts tests/
git commit -m "feat(gemini): serve chat completions through the Gemini adapter"
```

---

## Task 9: Dropped-parameter reporting

**Files:**
- Modify: `src/lib/gateway/chat-handler.ts:7,56-58`
- Test: `tests/gateway/dropped-params.test.ts`

**Interfaces:**
- Consumes: `droppedParams` from `@/lib/translate/chat-to-gemini` (Task 3).
- Produces: nothing new. `droppedFor` keeps its signature.

- [ ] **Step 1: Write the failing test**

Append to `tests/gateway/dropped-params.test.ts`. It already imports `chatRequest`,
`fakeAdapterByProvider` and `seedTargets` from `../helpers/gateway`, and defines a local
`completion(from)` helper — all four are reused as-is. `TargetSpec` already carries an
`adapter` field, so no helper needs changing.

```ts
test('a gemini target reports what Gemini cannot express', async () => {
  const { apiKey } = await seedTargets({ targets: [{ name: 'gem', adapter: 'gemini' }] })

  const res = await handleChatCompletions(
    chatRequest(
      {
        model: 'house-model',
        messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'be terse' }],
        logprobs: true,
      },
      apiKey,
    ),
    fakeAdapterByProvider({ gem: { chat: vi.fn().mockResolvedValue(completion('gem')) } }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-dropped-params')?.split(',').sort())
    .toEqual(['logprobs', 'system_message_hoisted'])
})

test('a gemini target reports nothing for a request it can express fully', async () => {
  // `n: 3` is the case that separates the two translators: the Responses
  // flavor drops it, Gemini sends it as candidateCount.
  const { apiKey } = await seedTargets({ targets: [{ name: 'gem', adapter: 'gemini' }] })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], n: 3 },
      apiKey,
    ),
    fakeAdapterByProvider({ gem: { chat: vi.fn().mockResolvedValue(completion('gem')) } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/gateway/dropped-params.test.ts`
Expected: FAIL — the header is absent, because `droppedFor` only reports for the
`responses` flavor.

- [ ] **Step 3: Implement**

In `src/lib/gateway/chat-handler.ts`, add the import beside the existing one:

```ts
import { droppedParams as geminiDroppedParams } from '@/lib/translate/chat-to-gemini'
```

and replace the body of `droppedFor`:

```ts
function droppedFor(candidate: Candidate, body: ChatCompletionRequest): string[] {
  // Adapter first, then flavor: a gemini provider has an api_flavor column like
  // every other row, but its adapter ignores it and the provider form hides the
  // selector, so reading flavor here would report the wrong protocol's losses.
  if (candidate.provider.adapter === 'gemini') return geminiDroppedParams(body)
  return resolveApiFlavor(candidate.provider) === 'responses' ? droppedParams(body) : []
}
```

Leave the doc comment above the function exactly as it is — it explains why this lives in
the handler at all, and that reason has not changed.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/gateway/dropped-params.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/gateway/chat-handler.ts tests/gateway/dropped-params.test.ts
git commit -m "feat(gemini): report the parameters a Gemini target cannot express"
```

---

## Task 10: Contract test and documentation

**Files:**
- Create: `tests/contract/gemini-client.test.ts`
- Modify: `README.md` (routing section ~line 159, limitations ~line 358)

**Interfaces:** none new.

- [ ] **Step 1: Write the contract test**

This proves the whole round trip: a real `openai` SDK client in, Gemini shapes upstream, a
real chat completion back. It builds the actual `createGeminiAdapter` over a fake
`GoogleGenAI`, so every layer except the network is exercised.

Create `tests/contract/gemini-client.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { createGeminiAdapter } from '@/lib/adapters/gemini'
import { resolveProviderRuntime } from '@/lib/adapters/registry'
import type { ProviderRow } from '@/lib/db/schema'
import { seedGateway } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

const answer = {
  modelVersion: 'gemini-2.5-flash-001',
  candidates: [{
    content: { role: 'model', parts: [{ text: 'It is sunny in Paris.' }] },
    finishReason: 'STOP',
  }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12, totalTokenCount: 52 },
}

const toolAnswer = {
  modelVersion: 'gemini-2.5-flash-001',
  candidates: [{
    content: {
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
    },
    finishReason: 'STOP',
  }],
}

/**
 * A gateway-backed OpenAI client whose upstream is the real Gemini adapter over
 * a fake SDK client. `sent` collects what Gemini was actually asked for, which
 * is what makes the request-side translation observable from a contract test.
 */
function gatewayClient(apiKey: string, responses: unknown[]) {
  const sent: Record<string, unknown>[] = []
  const remaining = [...responses]

  const fakeGenAI = {
    models: {
      generateContent: async (params: Record<string, unknown>) => {
        sent.push(params)
        return remaining.shift()
      },
      generateContentStream: async (params: Record<string, unknown>) => {
        sent.push(params)
        const response = remaining.shift()
        return (async function* () {
          yield response
        })()
      },
      list: async () => (async function* () {})(),
    },
    files: { upload: async () => ({ uri: 'files/x', mimeType: 'image/png' }) },
  }

  const deps = {
    createAdapter: (provider: ProviderRow) =>
      createGeminiAdapter(resolveProviderRuntime(provider), () => fakeGenAI as never),
  }

  const client = new OpenAI({
    apiKey,
    baseURL: 'http://gateway.test/v1',
    maxRetries: 0,
    fetch: ((url: string, init?: RequestInit) =>
      handleChatCompletions(new Request(url, init), deps)) as unknown as typeof fetch,
  })

  return { client, sent }
}

async function seedGemini() {
  return seedGateway({
    adapter: 'gemini',
    credentials: { apiKey: 'g-key' },
    upstreamModel: 'gemini-2.5-flash',
  })
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '7'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('the SDK completes a non-streaming request through the Gemini adapter', async () => {
  const { apiKey } = await seedGemini()
  const { client, sent } = gatewayClient(apiKey, [answer])

  const result = await client.chat.completions.create({
    model: 'house-model',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather in Paris?' },
    ],
  })

  expect(sent[0]).toMatchObject({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'weather in Paris?' }] }],
  })
  expect((sent[0].config as { systemInstruction: string }).systemInstruction).toBe('be terse')

  expect(result.choices[0].message.content).toBe('It is sunny in Paris.')
  expect(result.choices[0].finish_reason).toBe('stop')
  expect(result.usage?.total_tokens).toBe(52)
  // The gateway stamps its own identity over the upstream's.
  expect(result.model).toBe('house-model')
  expect(result.id.startsWith('chatcmpl-')).toBe(true)
})

test('the SDK streams through the Gemini adapter', async () => {
  const { apiKey } = await seedGemini()
  const { client } = gatewayClient(apiKey, [answer])

  const stream = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    stream: true,
  })

  const deltas: string[] = []
  let usageSeen = false
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content
    if (content) deltas.push(content)
    if (chunk.usage) usageSeen = true
  }

  expect(deltas.join('')).toBe('It is sunny in Paris.')
  expect(usageSeen).toBe(true)
})

test('a tool call round trip correlates the result back to its function name', async () => {
  const { apiKey } = await seedGemini()
  const { client, sent } = gatewayClient(apiKey, [toolAnswer, answer])

  const tools = [{
    type: 'function' as const,
    function: {
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  }]

  const first = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools,
  })

  const call = first.choices[0].message.tool_calls?.[0]
  expect(first.choices[0].finish_reason).toBe('tool_calls')
  expect(call?.function.name).toBe('get_weather')

  await client.chat.completions.create({
    model: 'house-model',
    messages: [
      { role: 'user', content: 'weather in Paris?' },
      first.choices[0].message,
      { role: 'tool', tool_call_id: call!.id, content: '{"temp":21}' },
    ],
    tools,
  })

  // The client echoed back an id the gateway synthesized; the translator has to
  // resolve it to the function's name, because that is what Gemini keys on.
  const contents = sent[1].contents as { role: string; parts: unknown[] }[]
  expect(contents.at(-1)?.parts[0]).toEqual({
    functionResponse: { id: call!.id, name: 'get_weather', response: { temp: 21 } },
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/contract/gemini-client.test.ts`
Expected: PASS.

- [ ] **Step 3: Update the README routing note**

Find the sentence reading "A target whose provider type has no adapter yet (`gemini`,
`bedrock`) is skipped and the chain continues." Change the parenthetical to `bedrock` alone.

- [ ] **Step 4: Update the README limitations**

Replace the bullet beginning "**No Gemini or Bedrock adapters…**" with one naming Bedrock
only, and add a bullet recording the image-fetch behaviour:

```markdown
- **A Gemini provider fetches remote images on a caller's behalf.** Chat
  Completions carries images as URLs; Gemini does not accept them, so the
  gateway downloads any `image_url` that is not a `data:` URI and uploads it to
  the Files API. The fetch is capped at 20 MB, bounded by the request timeout,
  and refuses non-image content types — but it is not restricted to an
  allowlist of hosts. A caller who can reach the gateway can make it issue a GET
  to any URL it can route to.
```

- [ ] **Step 5: Add a Gemini section to the README**

Place it after the Responses-flavor material, covering: that `/v1/chat/completions` stays
the only ingress; that system messages are hoisted into `systemInstruction` and reported
when that reorders anything; that `reasoning_effort` maps to Gemini's thinking levels and
thoughts come back as `reasoning_content`; that model discovery contributes context window
and token limits to the catalog; and the dropped parameter list from spec section 3.5.

- [ ] **Step 6: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add tests/contract/gemini-client.test.ts README.md
git commit -m "docs(gemini): document the Gemini adapter and its image fetching"
```

---

## Self-Review Notes

Spec coverage check, section by section:

| Spec section | Task |
|---|---|
| 3.1 Developer API through `@google/genai` | 1, 7 |
| 3.2 Pure translation, two-pass media | 2, 6, 8 |
| 3.3 System hoisting and its report | 2, 3 |
| 3.4 Tool correlation by name | 2, 3 |
| 3.5 Parameter mapping and drops | 3 |
| 3.6 Thinking ↔ reasoning_effort | 3, 4, 5 |
| 3.7 Response translation, usage arithmetic | 4 |
| 3.8 Stream translation | 5 |
| 3.9 Error classification | 1 |
| 3.10 Discovery and catalog fields | 7 |
| 3.11 Media resolution | 6 |
| 3.12 Dropped-param dispatch | 9 |
| 5 Testing, including moved tests | every task; moves in 8 |
| 6 Documentation | 10 |
| 7 What does not change | verified by `pnpm test` in 8 and 9 |
