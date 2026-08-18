# Anthropic Messages API Flavor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a model declare the API flavor `anthropic_messages`, so the gateway calls it on the Anthropic Messages API while its clients keep speaking Chat Completions and the Responses API.

**Architecture:** A third branch in `createAdapter` returns a new chat-only adapter built on `@anthropic-ai/sdk`, wrapped by the existing `withRespondViaChat` so the Responses ingress reaches it through `responses-to-chat.ts` with no new translator. All wire translation lives in one pure module, `src/lib/translate/chat-to-anthropic.ts`, beside `chat-to-gemini.ts` and testable without a client. The path system gains a fourth endpoint, and the `Candidate` gains the model's output ceiling, because the Messages API requires `max_tokens`.

**Tech Stack:** TypeScript, Next.js 16, Drizzle + Postgres, Vitest, `@anthropic-ai/sdk`.

**Spec:** `docs/superpowers/specs/2026-08-18-anthropic-messages-flavor-design.md`

## Global Constraints

- Work happens on the current branch, `worktree-responses-api`. No worktree.
- **Never point tests at port 5432.** Tests read `.env.test`, whose `DATABASE_URL` names a database on **5434**. Start it with `pnpm test:db:up`. Never run `pnpm test:db:down` — it reaches every checkout.
- Run a single file with `pnpm test <path>`; a single case with `pnpm test <path> -t "<name>"`. The full suite is `pnpm test`.
- `pnpm typecheck` and `pnpm lint` must pass before any commit.
- The flavor's stored value is exactly `anthropic_messages`; its label is exactly `Anthropic Messages`.
- Translation modules are pure: no `server-only`, no client, no I/O. Adapters hold no translation logic.
- Commit after every task, in the style of the existing history: a `type(scope): imperative subject` line, then a body explaining why. End every commit message with the two trailer lines used on this branch (`Co-Authored-By:` and `Claude-Session:`) — copy them from `git log -1 --format=%B` of an earlier commit.
- Never send `budget_tokens`. Adaptive thinking only.

---

### Task 1: Install the SDK and prove the per-request path option

The whole design assumes `@anthropic-ai/sdk` honours a per-request `path`, the way `adapters/openai/index.ts` passes `{ path: paths.chatCompletions }`. Prove it before anything is built on it.

**Files:**
- Modify: `package.json`
- Create: `tests/lib/adapters/anthropic/client-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `@anthropic-ai/sdk` dependency, and a verified answer to whether `client.messages.create(body, { path })` targets the given path.

- [ ] **Step 1: Install the SDK**

```bash
pnpm add @anthropic-ai/sdk
```

- [ ] **Step 2: Write the probe test**

Create `tests/lib/adapters/anthropic/client-path.test.ts`:

```ts
import { expect, test } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'

/**
 * The whole path design rests on the SDK honouring a per-request `path`, as
 * the OpenAI SDK does. This test is the proof, and it stays as the regression
 * that would catch an SDK upgrade taking the option away.
 */
test('a per-request path replaces the SDK default and joins onto the base URL', async () => {
  const seen: string[] = []
  const fetchStub: typeof fetch = async (input) => {
    seen.push(typeof input === 'string' ? input : String((input as Request).url))
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const client = new Anthropic({
    apiKey: 'sk-test',
    baseURL: 'https://upstream.test/v1',
    fetch: fetchStub,
    maxRetries: 0,
  })

  await client.messages.create(
    { model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    { path: '/messages' } as never,
  )

  expect(seen).toEqual(['https://upstream.test/v1/messages'])
})
```

- [ ] **Step 3: Run it**

Run: `pnpm test tests/lib/adapters/anthropic/client-path.test.ts`
Expected: PASS.

**If it fails** because the SDK rejects or ignores `path`: change the probe to assert the fallback instead — `client.post('/messages', { body, stream: false })` reaching `https://upstream.test/v1/messages` — and record at the top of the file, in a comment, that every later task must use `client.post(path, …)` in place of `client.messages.create(body, { path })`. Do not proceed until one of the two forms is proven.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tests/lib/adapters/anthropic/client-path.test.ts
git commit  # chore(deps): add the Anthropic SDK and pin its per-request path
```

---

### Task 2: Give the path system a fourth endpoint and a home outside `openai/`

`paths.ts` is about to serve an adapter that is not OpenAI-shaped, so it moves up a directory; and it gains `messages`.

**Files:**
- Move: `src/lib/adapters/openai/paths.ts` → `src/lib/adapters/paths.ts`
- Move: `tests/lib/adapters/openai/paths.test.ts` → `tests/lib/adapters/paths.test.ts`
- Modify (import only): `src/lib/adapters/openai/index.ts:12`, `src/lib/adapters/openai/responses.ts:17`, `src/lib/admin/catalog.ts:18`, `src/lib/admin/providers.ts:11`, `src/app/(admin)/providers/actions.ts:12`, `src/app/(admin)/providers/advanced-paths-fields.tsx:10`, `src/app/(admin)/catalog/catalog-forms.tsx:12`
- Modify: `src/lib/adapters/types.ts` (`ProviderConfig.messagesPath`, `ModelPathOverrides.messagesPath`)

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_PATHS.messages`, `ProviderPaths['messages']`, `ProviderConfig.messagesPath`, `ModelPathOverrides.messagesPath`, and `PATH_FIELDS`/`MODEL_PATH_FIELDS` entries named `messagesPath`. Every later task imports from `@/lib/adapters/paths`.

- [ ] **Step 1: Move the module and update its importers**

```bash
git mv src/lib/adapters/openai/paths.ts src/lib/adapters/paths.ts
git mv tests/lib/adapters/openai/paths.test.ts tests/lib/adapters/paths.test.ts
```

In `src/lib/adapters/openai/index.ts` and `src/lib/adapters/openai/responses.ts`, change `from './paths'` to `from '../paths'`. In the five `@/lib/adapters/openai/paths` importers (and in the moved test), change the specifier to `@/lib/adapters/paths`.

- [ ] **Step 2: Write the failing tests for the new endpoint**

Append to `tests/lib/adapters/paths.test.ts`:

```ts
test('messages defaults to /messages and joins onto the base URL', () => {
  const paths = resolveRequestPaths({}, 'https://api.anthropic.com/v1')
  expect(paths.messages).toBe('/messages')
})

test('a configured messages path resolves against the base URL origin', () => {
  const paths = resolveRequestPaths(
    { messagesPath: '/anthropic/v1/messages' },
    'https://gateway.test/openai/v1',
  )
  expect(paths.messages).toBe('https://gateway.test/anthropic/v1/messages')
})

test('the messages path is offered on both the provider and the model forms', () => {
  expect(PATH_FIELDS.map((f) => f.name)).toContain('messagesPath')
  expect(MODEL_PATH_FIELDS.map((f) => f.name)).toContain('messagesPath')
})
```

Make sure `PATH_FIELDS` and `MODEL_PATH_FIELDS` are in the file's import list.

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm test tests/lib/adapters/paths.test.ts`
Expected: FAIL — `paths.messages` is undefined.

- [ ] **Step 4: Add the endpoint**

In `src/lib/adapters/paths.ts`:

```ts
export const DEFAULT_PATHS = {
  models: '/models',
  chatCompletions: '/chat/completions',
  responses: '/responses',
  // Relative like the others, so a base URL that carries its own `/v1`
  // still resolves correctly. The Anthropic SDK's own default is the
  // absolute `/v1/messages`; the adapter always passes an explicit path,
  // so that default never applies and cannot double the prefix.
  messages: '/messages',
} as const
```

```ts
const CONFIG_KEYS: Record<keyof ProviderPaths, string> = {
  models: 'modelsPath',
  chatCompletions: 'chatCompletionsPath',
  responses: 'responsesPath',
  messages: 'messagesPath',
}
```

Add to `PATH_FIELDS`:

```ts
  {
    name: 'messagesPath',
    label: 'Messages path',
    placeholder: DEFAULT_PATHS.messages,
    help: 'Where this provider serves the Anthropic Messages API.',
  },
```

Add to `MODEL_PATH_FIELDS`:

```ts
  {
    name: 'messagesPath',
    label: 'Messages path',
    placeholder: DEFAULT_PATHS.messages,
    help: 'Where this one model answers the Anthropic Messages API.',
  },
```

Add `messages: resolveOne(config, 'messages').path` to `resolveProviderPaths` and `messages: resolve('messages')` to `resolveRequestPaths`.

In `src/lib/adapters/types.ts`, add `messagesPath?: string` to `ProviderConfig` beside the other two path keys, and `messagesPath?: string | null` to `ModelPathOverrides`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/lib/adapters/paths.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify nothing else broke**

Run: `pnpm typecheck && pnpm lint && pnpm test tests/lib/adapters tests/lib/admin`
Expected: clean and green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit  # refactor(adapters): move path resolution out of openai/ and add the messages endpoint
```

---

### Task 3: The flavor value, the enum, and the model's messages path column

**Files:**
- Modify: `src/lib/api-flavors.ts`
- Modify: `src/lib/db/schema.ts:151-160` (the gateway-settings columns on `catalogModels`)
- Create: `drizzle/0009_*.sql` and its snapshot (generated)
- Modify: `tests/lib/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `'anthropic_messages'` in `API_FLAVORS`, `API_FLAVOR_LABELS.anthropic_messages === 'Anthropic Messages'`, and `catalogModels.messagesPath` (`messages_path text`, nullable).

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/db/schema.test.ts`:

```ts
test('anthropic_messages is a settable api_flavor on a model', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'anthropic-test',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.anthropic.com/v1',
    credentials: encryptJson({ apiKey: 'sk-test' }),
  }).returning()

  const [model] = await db.insert(catalogModels).values({
    providerId: provider.id,
    modelId: 'claude-opus-5',
    apiFlavor: 'anthropic_messages',
    messagesPath: '/anthropic/v1/messages',
  }).returning()

  expect(model.apiFlavor).toBe('anthropic_messages')
  expect(model.messagesPath).toBe('/anthropic/v1/messages')
})

test('a model that names no messages path inherits by storing null', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'inherits',
    adapter: 'openai',
    credentials: encryptJson({ apiKey: 'sk-test' }),
  }).returning()

  const [model] = await db.insert(catalogModels).values({
    providerId: provider.id,
    modelId: 'gpt-5',
  }).returning()

  expect(model.messagesPath).toBeNull()
})
```

Match the file's existing import list and `resetDb()` usage rather than inventing new fixtures.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:db:up && pnpm test tests/lib/db/schema.test.ts`
Expected: FAIL — the enum has no such value and the column does not exist.

- [ ] **Step 3: Declare the value and the column**

`src/lib/api-flavors.ts`:

```ts
export const API_FLAVORS = ['chat_completions', 'responses', 'anthropic_messages'] as const
```

```ts
export const API_FLAVOR_LABELS: Record<ApiFlavor, string> = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
  anthropic_messages: 'Anthropic Messages',
}
```

In `src/lib/db/schema.ts`, beside `chatCompletionsPath` and `responsesPath` on `catalogModels`:

```ts
    messagesPath: text('messages_path'),
```

- [ ] **Step 4: Generate and inspect the migration**

```bash
pnpm db:generate
```

Read the generated `drizzle/0009_*.sql`. It must contain an `ALTER TYPE "public"."api_flavor" ADD VALUE 'anthropic_messages'` and an `ALTER TABLE "catalog_models" ADD COLUMN "messages_path" text`. Postgres forbids *using* a newly added enum value in the same transaction that added it; adding a `text` column does not use it, so one migration is fine. If drizzle emits anything that does use the new value (a default, a check), split it into `0009` (the enum value) and `0010` (everything else).

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/lib/db/schema.test.ts`
Expected: PASS. (`tests/setup/global-setup.ts` applies pending migrations.)

- [ ] **Step 6: Verify the suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green. Some admin tests iterate `API_FLAVORS`; if one asserts a length or an exact array, update it to include the new value.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit  # feat(catalog): add the anthropic_messages flavor and a model messages path
```

---

### Task 4: `chat-to-anthropic.ts` — the request

**Files:**
- Create: `src/lib/translate/chat-to-anthropic.ts`
- Create: `tests/lib/translate/chat-to-anthropic-request.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig` from `@/lib/adapters/types`, `ChatCompletionRequest`/`ChatMessage` from `@/lib/schemas/chat`.
- Produces:

```ts
export function toMessagesRequest(
  req: ChatCompletionRequest,
  upstreamModel: string,
  config?: ProviderConfig,
  maxOutputTokens?: number | null,
): Anthropic.MessageCreateParams
```

Read `src/lib/translate/chat-to-gemini.ts` first. This module is its sibling and should read like it: same helper names where the job is the same (`textOf`, `asObject`), same habit of recording *why* in comments, same "drop rather than reject" philosophy.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/translate/chat-to-anthropic-request.test.ts`:

```ts
import { expect, test } from 'vitest'
import { toMessagesRequest } from '@/lib/translate/chat-to-anthropic'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function req(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'virtual',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
}

test('system and developer messages hoist to the top-level system parameter', () => {
  const out = toMessagesRequest(req({
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'developer', content: 'and precise' },
      { role: 'user', content: 'hi' },
    ],
  }), 'claude-opus-5')

  expect(out.system).toBe('be terse\n\nand precise')
  expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
})

test('max_tokens falls back through the client, the catalog, then the constant', () => {
  expect(toMessagesRequest(req({ max_tokens: 10 }), 'm').max_tokens).toBe(10)
  expect(toMessagesRequest(req({ max_completion_tokens: 20, max_tokens: 10 }), 'm').max_tokens).toBe(20)
  expect(toMessagesRequest(req(), 'm', {}, 64000).max_tokens).toBe(64000)
  expect(toMessagesRequest(req(), 'm', {}, null).max_tokens).toBe(4096)
})

test('an http image becomes a url source and a data url becomes a base64 source', () => {
  const out = toMessagesRequest(req({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'https://img.test/a.png' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      ],
    }],
  }), 'm')

  expect(out.messages[0].content).toEqual([
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'url', url: 'https://img.test/a.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
  ])
})

test('assistant tool calls become tool_use and tool messages become tool_result', () => {
  const out = toMessagesRequest(req({
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '18C' },
    ],
  }), 'm')

  expect(out.messages[1]).toEqual({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }],
  })
  expect(out.messages[2]).toEqual({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '18C' }],
  })
})

test('tools, tool_choice and parallel_tool_calls map onto the Messages shapes', () => {
  const tools = [{
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Look up weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  }]

  expect(toMessagesRequest(req({ tools }), 'm').tools).toEqual([{
    name: 'get_weather',
    description: 'Look up weather',
    input_schema: { type: 'object', properties: { city: { type: 'string' } } },
  }])

  expect(toMessagesRequest(req({ tools, tool_choice: 'required' }), 'm').tool_choice)
    .toEqual({ type: 'any' })
  expect(toMessagesRequest(req({ tools, tool_choice: 'none' }), 'm').tool_choice)
    .toEqual({ type: 'none' })
  expect(toMessagesRequest(req({
    tools, tool_choice: { type: 'function', function: { name: 'get_weather' } },
  }), 'm').tool_choice).toEqual({ type: 'tool', name: 'get_weather' })
  expect(toMessagesRequest(req({ tools, parallel_tool_calls: false }), 'm').tool_choice)
    .toEqual({ type: 'auto', disable_parallel_tool_use: true })
})

test('sampling, stop sequences and the user identifier carry across', () => {
  const out = toMessagesRequest(req({
    temperature: 0.2, top_p: 0.9, stop: ['STOP', ''], user: 'u-1',
  }), 'm')

  expect(out.temperature).toBe(0.2)
  expect(out.top_p).toBe(0.9)
  expect(out.stop_sequences).toEqual(['STOP'])
  expect(out.metadata).toEqual({ user_id: 'u-1' })
})

test('thinking is asked for only when the client or the provider asked for it', () => {
  expect(toMessagesRequest(req(), 'm').thinking).toBeUndefined()

  const asked = toMessagesRequest(req({ reasoning_effort: 'high' }), 'm')
  expect(asked.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  expect((asked as { output_config?: unknown }).output_config).toEqual({ effort: 'high' })

  const byConfig = toMessagesRequest(req(), 'm', { requestReasoningSummary: true })
  expect(byConfig.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  expect((byConfig as { output_config?: unknown }).output_config).toBeUndefined()
})

test('effort maps OpenAI vocabulary and forwards anything else verbatim', () => {
  const effortOf = (effort: string) =>
    (toMessagesRequest(req({ reasoning_effort: effort }), 'm') as {
      output_config?: { effort?: string }
    }).output_config?.effort

  expect(effortOf('minimal')).toBe('low')
  expect(effortOf('medium')).toBe('medium')
  expect(effortOf('xhigh')).toBe('xhigh')

  const none = toMessagesRequest(req({ reasoning_effort: 'none' }), 'm')
  expect(none.thinking).toBeUndefined()
  expect((none as { output_config?: unknown }).output_config).toBeUndefined()
})

test('budget_tokens is never sent', () => {
  const out = toMessagesRequest(req({ reasoning_effort: 'high' }), 'm')
  expect(JSON.stringify(out)).not.toContain('budget_tokens')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test tests/lib/translate/chat-to-anthropic-request.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Create `src/lib/translate/chat-to-anthropic.ts`. The request half:

```ts
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
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match ? { mediaType: match[1], data: match[2] } : null
}

function imageBlock(url: string): Anthropic.ImageBlockParam {
  const inline = dataUrl(url)
  return inline
    ? { type: 'image', source: { type: 'base64', media_type: inline.mediaType as never, data: inline.data } }
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/translate/chat-to-anthropic-request.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add src/lib/translate/chat-to-anthropic.ts tests/lib/translate/chat-to-anthropic-request.test.ts
git commit  # feat(translate): build Anthropic Messages requests from Chat Completions
```

---

### Task 5: `chat-to-anthropic.ts` — the response

**Files:**
- Modify: `src/lib/translate/chat-to-anthropic.ts`
- Create: `tests/lib/translate/chat-to-anthropic-response.test.ts`

**Interfaces:**
- Consumes: Task 4's module.
- Produces: `export function fromMessage(msg: Anthropic.Message, model: string): ChatCompletion` and, for Task 6's reuse, `finishReasonFor(stopReason: string | null | undefined, hasToolCalls: boolean)` and `toUsage(usage)` as module-private helpers.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/translate/chat-to-anthropic-response.test.ts`:

```ts
import { expect, test } from 'vitest'
import { fromMessage } from '@/lib/translate/chat-to-anthropic'

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  } as never
}

test('text blocks join into the assistant message', () => {
  const out = fromMessage(message({
    content: [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }],
  }), 'fallback')

  expect(out.id).toBe('msg_1')
  expect(out.object).toBe('chat.completion')
  expect(out.model).toBe('claude-opus-5')
  expect(out.choices[0].message.content).toBe('hello')
  expect(out.choices[0].finish_reason).toBe('stop')
})

test('thinking blocks become reasoning_content and redacted ones are skipped', () => {
  const out = fromMessage(message({
    content: [
      { type: 'thinking', thinking: 'weighing it up' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'answer' },
    ],
  }), 'm')

  const choice = out.choices[0].message as { content: string; reasoning_content?: string }
  expect(choice.reasoning_content).toBe('weighing it up')
  expect(choice.content).toBe('answer')
})

test('tool_use blocks become tool calls with re-serialized arguments', () => {
  const out = fromMessage(message({
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }],
    stop_reason: 'tool_use',
  }), 'm')

  expect(out.choices[0].message.tool_calls).toEqual([{
    id: 'toolu_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
  }])
  expect(out.choices[0].finish_reason).toBe('tool_calls')
})

test('stop reasons map onto finish reasons', () => {
  const reasonOf = (stop: string, content: unknown[] = [{ type: 'text', text: 'x' }]) =>
    fromMessage(message({ stop_reason: stop, content }), 'm').choices[0].finish_reason

  expect(reasonOf('end_turn')).toBe('stop')
  expect(reasonOf('stop_sequence')).toBe('stop')
  expect(reasonOf('pause_turn')).toBe('stop')
  expect(reasonOf('max_tokens')).toBe('length')
  expect(reasonOf('refusal')).toBe('content_filter')
})

test('truncation outranks a tool call, so a cut-off call is not reported as complete', () => {
  const out = fromMessage(message({
    content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }],
    stop_reason: 'max_tokens',
  }), 'm')

  expect(out.choices[0].finish_reason).toBe('length')
})

test('cache tokens are counted into prompt tokens and reported separately', () => {
  const out = fromMessage(message({
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
  }), 'm')

  expect(out.usage).toEqual({
    prompt_tokens: 130,
    completion_tokens: 5,
    total_tokens: 135,
    prompt_tokens_details: { cached_tokens: 100 },
  })
})

test('no reasoning_tokens are invented, because Anthropic reports none', () => {
  const out = fromMessage(message({
    content: [{ type: 'thinking', thinking: 'long thought' }, { type: 'text', text: 'a' }],
  }), 'm')

  expect(out.usage).not.toHaveProperty('completion_tokens_details')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test tests/lib/translate/chat-to-anthropic-response.test.ts`
Expected: FAIL — `fromMessage` is not exported.

- [ ] **Step 3: Add the response half**

Append to `src/lib/translate/chat-to-anthropic.ts`:

```ts
import type { ChatCompletion, ChatCompletionChunk } from '@/lib/adapters/types'

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

/**
 * Shared with the stream translator, which derives the same reason from the
 * stop_reason carried on message_delta.
 *
 * Truncation and refusal outrank a present tool call, for the reason
 * chat-to-gemini records: a call that finished on max_tokens may have
 * truncated arguments, and reporting `tool_calls` would hide that from the
 * client.
 */
function finishReasonFor(
  stopReason: string | null | undefined,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'refusal') return 'content_filter'
  if (hasToolCalls || stopReason === 'tool_use') return 'tool_calls'
  return 'stop'
}

interface AnthropicUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/**
 * Cache tokens are input tokens that were read from or written to the cache,
 * reported beside `input_tokens` rather than inside it. Leaving them out would
 * under-report prompt tokens on every cached request, and cost is computed
 * from these.
 *
 * There is no reasoning-token equivalent: Anthropic bills thinking inside
 * output_tokens and reports no separate count, so completion_tokens_details is
 * omitted rather than filled with a number nothing measured.
 */
function toUsage(usage: AnthropicUsage) {
  const cached = usage.cache_read_input_tokens ?? 0
  const promptTokens = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0)
  const completionTokens = usage.output_tokens ?? 0

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  }
}

export function fromMessage(msg: Anthropic.Message, model: string): ChatCompletion {
  let content = ''
  let reasoning = ''
  const toolCalls: ToolCall[] = []

  for (const block of msg.content ?? []) {
    if (block.type === 'text') content += block.text
    else if (block.type === 'thinking') reasoning += block.thinking
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
    // redacted_thinking carries no readable text — it is an opaque blob the
    // model can replay to itself — so there is nothing to surface.
  }

  return {
    id: msg.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: msg.model ?? model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        // Non-standard, and deliberately so: it is the convention DeepSeek,
        // vLLM and OpenRouter already use, and the field responses-to-chat.ts
        // reads when this crossing is followed by a second one.
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReasonFor(msg.stop_reason, toolCalls.length > 0),
      logprobs: null,
    }],
    ...(msg.usage ? { usage: toUsage(msg.usage) } : {}),
  } as ChatCompletion
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/translate/chat-to-anthropic-response.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add src/lib/translate/chat-to-anthropic.ts tests/lib/translate/chat-to-anthropic-response.test.ts
git commit  # feat(translate): read an Anthropic message back as a chat completion
```

---

### Task 6: `chat-to-anthropic.ts` — the stream

**Files:**
- Modify: `src/lib/translate/chat-to-anthropic.ts`
- Create: `tests/lib/translate/chat-to-anthropic-stream.test.ts`

**Interfaces:**
- Consumes: Task 5's `finishReasonFor` and `toUsage`.
- Produces:

```ts
export async function* fromMessageStream(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  req: ChatCompletionRequest,
  model: string,
): AsyncIterable<ChatCompletionChunk>
```

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/translate/chat-to-anthropic-stream.test.ts`:

```ts
import { expect, test } from 'vitest'
import { fromMessageStream } from '@/lib/translate/chat-to-anthropic'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

const req = { model: 'v', messages: [{ role: 'user', content: 'hi' }] } as ChatCompletionRequest

async function* feed(events: unknown[]) {
  for (const event of events) yield event as never
}

async function collect(events: unknown[], request = req) {
  const out = []
  for await (const chunk of fromMessageStream(feed(events), request, 'claude-opus-5')) {
    out.push(chunk)
  }
  return out
}

const start = {
  type: 'message_start',
  message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 },
  },
}

test('text deltas become content deltas, with the role on the first one', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'he' })
  expect(chunks[1].choices[0].delta).toEqual({ content: 'llo' })
  expect(chunks[2].choices[0].finish_reason).toBe('stop')
  expect(chunks.at(-1)?.usage).toEqual({
    prompt_tokens: 7, completion_tokens: 3, total_tokens: 10,
  })
})

test('thinking deltas become reasoning_content', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ])

  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', reasoning_content: 'hmm' })
  // The signature is replay state for the model, not content for the client.
  expect(chunks.filter((c) => 'content' in (c.choices[0]?.delta ?? {}))).toHaveLength(0)
})

test('a tool_use block streams as an indexed tool call with json argument deltas', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city"' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"Paris"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  ])

  expect(chunks[1].choices[0].delta).toEqual({
    tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '' } }],
  })
  expect(chunks[2].choices[0].delta).toEqual({
    tool_calls: [{ index: 0, function: { arguments: '{"city"' } }],
  })
  expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls')
})

test('two tool_use blocks keep separate tool call indexes', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'f', input: {} } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'g', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
  ])

  const indexes = chunks
    .flatMap((c) => (c.choices[0]?.delta as { tool_calls?: { index: number }[] })?.tool_calls ?? [])
    .map((call) => call.index)
  expect(indexes).toEqual([0, 1, 1])
})

test('stream_options.include_usage false suppresses the usage chunk', async () => {
  const chunks = await collect([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ], { ...req, stream_options: { include_usage: false } } as ChatCompletionRequest)

  expect(chunks.some((c) => c.usage)).toBe(false)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test tests/lib/translate/chat-to-anthropic-stream.test.ts`
Expected: FAIL — `fromMessageStream` is not exported.

- [ ] **Step 3: Add the stream half**

Append to `src/lib/translate/chat-to-anthropic.ts`:

```ts
/**
 * Anthropic streams semantic events over content blocks, which is closer to
 * the Responses stream than to Gemini's whole-response chunks. The state kept
 * here is small: which content-block index is which tool call (a Chat
 * Completions client indexes tool calls among themselves, while Anthropic
 * indexes every block), and whether the role has been announced.
 *
 * `n > 1` needs no bookkeeping at all — the Messages API has no equivalent, so
 * there is only ever choice 0.
 */
export async function* fromMessageStream(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  req: ChatCompletionRequest,
  model: string,
): AsyncIterable<ChatCompletionChunk> {
  const toolIndexes = new Map<number, number>()
  const created = Math.floor(Date.now() / 1000)
  let id = ''
  let responseModel = model
  let roleSent = false
  let toolCount = 0
  let sawToolUse = false
  const usage: AnthropicUsage = {}

  // Anthropic always reports usage, so include_usage needs no upstream
  // parameter — only an opt-out honoured here.
  const includeUsage = req.stream_options?.include_usage !== false

  function chunk(
    delta: Record<string, unknown>,
    reason: string | null = null,
  ): ChatCompletionChunk {
    // The role rides the first chunk carrying real content rather than the
    // first chunk of any kind, so the eager first-chunk pull in startStream
    // keeps meaning "the upstream produced something".
    const withRole = roleSent ? delta : { role: 'assistant', ...delta }
    roleSent = true
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model: responseModel,
      choices: [{ index: 0, delta: withRole, finish_reason: reason }],
    } as ChatCompletionChunk
  }

  for await (const event of events) {
    switch (event.type) {
      case 'message_start': {
        id = event.message.id ?? ''
        responseModel = event.message.model ?? model
        Object.assign(usage, event.message.usage ?? {})
        break
      }

      case 'content_block_start': {
        const block = event.content_block
        if (block.type !== 'tool_use') break
        sawToolUse = true
        const index = toolCount++
        toolIndexes.set(event.index, index)
        yield chunk({
          tool_calls: [{
            index, id: block.id, type: 'function',
            function: { name: block.name, arguments: '' },
          }],
        })
        break
      }

      case 'content_block_delta': {
        const delta = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string }
        if (delta.type === 'text_delta' && delta.text) {
          yield chunk({ content: delta.text })
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          yield chunk({ reasoning_content: delta.thinking })
        } else if (delta.type === 'input_json_delta') {
          const index = toolIndexes.get(event.index)
          if (index !== undefined) {
            yield chunk({
              tool_calls: [{ index, function: { arguments: delta.partial_json ?? '' } }],
            })
          }
        }
        // signature_delta is replay state the model verifies on a later turn,
        // not content the client ever renders.
        break
      }

      case 'message_delta': {
        Object.assign(usage, event.usage ?? {})
        const stop = (event.delta as { stop_reason?: string | null }).stop_reason
        if (stop) yield chunk({}, finishReasonFor(stop, sawToolUse))
        break
      }

      // message_stop and ping carry nothing a Chat Completions client needs:
      // the finish reason arrived on message_delta, and [DONE] is the
      // protocol's own terminator, written by the SSE layer.
      default:
        break
    }
  }

  if (includeUsage) {
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model: responseModel,
      choices: [],
      usage: toUsage(usage),
    } as ChatCompletionChunk
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/translate/chat-to-anthropic-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add src/lib/translate/chat-to-anthropic.ts tests/lib/translate/chat-to-anthropic-stream.test.ts
git commit  # feat(translate): relay an Anthropic message stream as chat completion chunks
```

---

### Task 7: `chat-to-anthropic.ts` — `droppedParams`

**Files:**
- Modify: `src/lib/translate/chat-to-anthropic.ts`
- Create: `tests/lib/translate/chat-to-anthropic-dropped.test.ts`

**Interfaces:**
- Consumes: Task 4's `asObject` and the module's message helpers.
- Produces: `export function droppedParams(req: ChatCompletionRequest): string[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/translate/chat-to-anthropic-dropped.test.ts`:

```ts
import { expect, test } from 'vitest'
import { droppedParams } from '@/lib/translate/chat-to-anthropic'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function req(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: 'v', messages: [{ role: 'user', content: 'hi' }], ...overrides } as ChatCompletionRequest
}

test('a plain request drops nothing', () => {
  expect(droppedParams(req())).toEqual([])
})

test('parameters the Messages API has no equivalent for are reported', () => {
  const dropped = droppedParams(req({
    seed: 1, response_format: { type: 'json_object' }, service_tier: 'flex',
    n: 2,
  } as Partial<ChatCompletionRequest>))

  expect(dropped).toEqual(expect.arrayContaining([
    'seed', 'response_format', 'service_tier', 'n',
  ]))
})

test('n of 1 and logprobs false mean the default and are not reported', () => {
  expect(droppedParams(req({ n: 1, logprobs: false } as Partial<ChatCompletionRequest>))).toEqual([])
})

test('penalties and logit_bias are reported', () => {
  const dropped = droppedParams(req({
    presence_penalty: 0.5, frequency_penalty: 0.5, logit_bias: { '1': 1 },
  } as Partial<ChatCompletionRequest>))

  expect(dropped).toEqual(expect.arrayContaining([
    'presence_penalty', 'frequency_penalty', 'logit_bias',
  ]))
})

test('a system message after the conversation started is reported as hoisted', () => {
  expect(droppedParams(req({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'now be terse' },
    ],
  }))).toContain('system_message_hoisted')

  expect(droppedParams(req({
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
  }))).not.toContain('system_message_hoisted')
})

test('a tool message with no resolvable call id is reported', () => {
  expect(droppedParams(req({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'result' },
    ],
  }))).toContain('unmatched_tool_call_id')
})

test('tool arguments that are not a JSON object are reported', () => {
  expect(droppedParams(req({
    messages: [{
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 'not json' } }],
    }],
  }))).toContain('malformed_tool_arguments')
})

test('a content part that is neither text nor an image is reported', () => {
  expect(droppedParams(req({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'watch' },
        { type: 'video_url', video_url: { url: 'https://v.test/a.mp4' } },
      ],
    }],
  }))).toContain('unsupported_content_part')
})

test('a strict tool schema is reported, since the Messages tools carry no such flag here', () => {
  expect(droppedParams(req({
    tools: [{
      type: 'function',
      function: { name: 'f', parameters: { type: 'object' }, strict: true },
    }],
  }))).toContain('strict_tool_schema')
})

test('reasoning_effort is not dropped — the translator carries it as thinking', () => {
  expect(droppedParams(req({ reasoning_effort: 'high' }))).not.toContain('reasoning_effort')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test tests/lib/translate/chat-to-anthropic-dropped.test.ts`
Expected: FAIL — `droppedParams` is not exported.

- [ ] **Step 3: Add the reporter**

Append to `src/lib/translate/chat-to-anthropic.ts`:

```ts
/**
 * Chat Completions parameters the Messages API cannot express, plus the
 * structural degradations above. Dropped rather than rejected, for the reason
 * chat-to-gemini records: SDKs and frameworks routinely send these meaning
 * nothing by them, and 400ing would make the gateway unusable against this
 * flavor without per-client configuration.
 *
 * `service_tier` earns its place here even though nothing in the request body
 * asked for it: bodyFor() injects it when a route target pins one, and an
 * operator who pinned a tier needs the header to say it did not cross.
 */
const UNMAPPABLE = [
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'seed',
  'response_format',
  'service_tier',
  'n',
] as const

/** Values that mean "the default", which is also what this API does.
 *  Reporting them would put a line in the header on nearly every request. */
const INERT: Record<string, unknown> = {
  logprobs: false,
  n: 1,
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
  return messages.slice(firstTurn).some((m) => m.role === 'system' || m.role === 'developer')
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

  const callIds = new Set<string>()
  for (const message of req.messages) {
    for (const call of message.tool_calls ?? []) callIds.add(call.id)
  }

  if (req.messages.some((m) =>
    (m.role === 'tool' || m.role === 'function')
    && (!m.tool_call_id || !callIds.has(m.tool_call_id)))) {
    dropped.push('unmatched_tool_call_id')
  }

  if (req.messages.some((m) =>
    (m.tool_calls ?? []).some((call) => asObject(call.function.arguments) === null))) {
    dropped.push('malformed_tool_arguments')
  }

  if (req.messages.some((m) =>
    Array.isArray(m.content)
    && m.content.some((part) => part.type !== 'text' && part.type !== 'image_url'))) {
    dropped.push('unsupported_content_part')
  }

  // A strict schema is a guarantee about the tool arguments the model
  // produces, and toTools carries only name, description and schema — so the
  // guarantee does not cross, and a client relying on it should hear about it.
  if (req.tools?.some((tool) => tool.function.strict === true)) {
    dropped.push('strict_tool_schema')
  }

  return dropped
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/translate/chat-to-anthropic-dropped.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add src/lib/translate/chat-to-anthropic.ts tests/lib/translate/chat-to-anthropic-dropped.test.ts
git commit  # feat(translate): report what a Chat Completions request loses crossing to Messages
```

---

### Task 8: The Anthropic adapter

**Files:**
- Create: `src/lib/adapters/anthropic/client.ts`
- Create: `src/lib/adapters/anthropic/errors.ts`
- Create: `src/lib/adapters/anthropic/index.ts`
- Create: `tests/lib/adapters/anthropic/chat.test.ts`
- Create: `tests/lib/adapters/anthropic/errors.test.ts`
- Create: `tests/lib/adapters/anthropic/models.test.ts`

**Interfaces:**
- Consumes: `toMessagesRequest`, `fromMessage`, `fromMessageStream` (Tasks 4–6); `resolveRequestPaths` from `@/lib/adapters/paths` (Task 2).
- Produces:

```ts
export type AnthropicClientFactory = (opts: ClientOptions) => Anthropic
export function createAnthropicClient(runtime: ProviderRuntime, factory?: AnthropicClientFactory): Anthropic
export function listModels(client: Anthropic, ctx: ListModelsContext, path: string): Promise<DiscoveredModel[]>
export function toProviderError(err: unknown, hint?: string): ProviderError
export function createAnthropicAdapter(
  runtime: ProviderRuntime,
  maxOutputTokens?: number | null,
  createClient?: AnthropicClientFactory,
): ChatOnlyAdapter
```

Read `src/lib/adapters/openai/index.ts`, `client.ts` and `errors.ts` first — this folder is their counterpart and should be recognisable as one.

- [ ] **Step 1: Write the failing adapter tests**

Create `tests/lib/adapters/anthropic/chat.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { createAnthropicAdapter } from '@/lib/adapters/anthropic'
import type { ProviderRuntime } from '@/lib/adapters/types'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function runtime(config: Record<string, unknown> = {}): ProviderRuntime {
  return {
    id: 'p1', name: 'anthropic-test', adapter: 'openai_compatible',
    baseUrl: 'https://api.anthropic.com/v1',
    credentials: { apiKey: 'sk-test' }, config,
  }
}

const req = {
  model: 'virtual', messages: [{ role: 'user', content: 'hi' }],
} as ChatCompletionRequest

const ctx = { upstreamModel: 'claude-opus-5', signal: new AbortController().signal, requestId: 'r1' }

function message(text: string) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function adapterWith(create: unknown, config: Record<string, unknown> = {}, ceiling: number | null = null) {
  const factory = vi.fn().mockReturnValue({ messages: { create } })
  return createAnthropicAdapter(runtime(config), ceiling, factory as never)
}

test('chat translates both ways and targets the resolved messages path', async () => {
  const create = vi.fn().mockResolvedValue(message('hello'))
  const completion = await adapterWith(create).chat(req, ctx)

  const [body, options] = create.mock.calls[0]
  expect(body.model).toBe('claude-opus-5')
  expect(body.stream).toBe(false)
  expect(body.max_tokens).toBe(4096)
  expect(options.path).toBe('/messages')
  expect(options.signal).toBe(ctx.signal)
  expect(completion.choices[0].message.content).toBe('hello')
})

test("the model's catalogued ceiling supplies max_tokens when the client sent none", async () => {
  const create = vi.fn().mockResolvedValue(message('x'))
  await adapterWith(create, {}, 64000).chat(req, ctx)
  expect(create.mock.calls[0][0].max_tokens).toBe(64000)
})

test('a configured messages path resolves against the base URL origin', async () => {
  const create = vi.fn().mockResolvedValue(message('x'))
  await adapterWith(create, { messagesPath: '/anthropic/v1/messages' }).chat(req, ctx)
  expect(create.mock.calls[0][1].path).toBe('https://api.anthropic.com/anthropic/v1/messages')
})

test('chatStream relays translated chunks', async () => {
  async function* events() {
    yield {
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 0 } },
    }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
  }
  const create = vi.fn().mockResolvedValue(events())

  const chunks = []
  for await (const chunk of adapterWith(create).chatStream(req, ctx)) chunks.push(chunk)

  expect(create.mock.calls[0][0].stream).toBe(true)
  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'hi' })
})
```

Create `tests/lib/adapters/anthropic/errors.test.ts`:

```ts
import { expect, test } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { toProviderError } from '@/lib/adapters/anthropic/errors'
import { ProviderError } from '@/lib/gateway/errors'

function apiError(status: number, message = 'boom') {
  return new Anthropic.APIError(status, { error: { message } }, message, undefined)
}

test('a 429 is retryable against another provider', () => {
  const err = toProviderError(apiError(429))
  expect(err).toBeInstanceOf(ProviderError)
  expect(err.status).toBe(429)
  expect(err.retryable).toBe(true)
})

test('a 400 is the request being wrong and is not retried elsewhere', () => {
  expect(toProviderError(apiError(400)).retryable).toBe(false)
})

test('a 404 carries the flavor hint, because a missing endpoint looks like this', () => {
  const err = toProviderError(apiError(404, 'not found'), 'set the flavor')
  expect(err.message).toBe('not found. set the flavor')
})

test('an abort becomes an upstream timeout', () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  const err = toProviderError(abort)
  expect(err.status).toBe(504)
  expect(err.code).toBe('upstream_timeout')
})
```

Create `tests/lib/adapters/anthropic/models.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { listModels } from '@/lib/adapters/anthropic/client'

test('listModels reports ids and whatever limits the endpoint states', async () => {
  const page = [
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', max_input_tokens: 1000000, max_tokens: 128000 },
    { id: '', display_name: 'nameless' },
    { id: 'claude-haiku-4-5' },
  ]
  const client = {
    models: { list: vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () { yield* page } }) },
  }

  const models = await listModels(client as never, { signal: new AbortController().signal }, '/models')

  expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-haiku-4-5'])
  expect(models[0].fields).toEqual({ contextWindow: 1000000, maxOutputTokens: 128000 })
  expect(models[1].fields).toEqual({})
  expect(client.models.list).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ path: '/models' }),
  )
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test tests/lib/adapters/anthropic`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write `client.ts`**

```ts
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import type { CatalogFields } from '@/lib/catalog/types'
import type { DiscoveredModel, ListModelsContext, ProviderRuntime } from '../types'

export type AnthropicClientFactory = (opts: ClientOptions) => Anthropic

const defaultFactory: AnthropicClientFactory = (opts) => new Anthropic(opts)

interface AnthropicCredentials {
  apiKey?: string
}

/**
 * The api key goes out as `x-api-key`, which is what the SDK does with one —
 * the header this API authenticates on, unlike the bearer token the OpenAI
 * shape uses. A clone that wants a bearer instead is not supported; it would
 * need a credential form of its own.
 */
export function createAnthropicClient(
  runtime: ProviderRuntime,
  factory: AnthropicClientFactory = defaultFactory,
): Anthropic {
  const credentials = runtime.credentials as AnthropicCredentials
  if (!credentials.apiKey) {
    throw new Error(`Provider "${runtime.name}" is missing an apiKey credential.`)
  }

  return factory({
    apiKey: credentials.apiKey,
    ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    // Failover is the gateway's job: an SDK retry would hold the request on a
    // target the routing loop has already decided to leave.
    maxRetries: 0,
  })
}

/**
 * What this endpoint reports about a model that the catalog can use. Unlike
 * an OpenAI-shaped `/v1/models`, it states limits — so this adapter, like
 * Gemini's, can fill the `discovered` layer with something.
 *
 * A field is left absent rather than nulled when the endpoint does not report
 * it: the merge layer treats absent and null the same today, but absent is the
 * encoding that will still be right when it distinguishes them.
 */
export function catalogFields(model: Record<string, unknown>): CatalogFields {
  const fields: CatalogFields = {}
  if (typeof model.max_input_tokens === 'number') fields.contextWindow = model.max_input_tokens
  if (typeof model.max_tokens === 'number') fields.maxOutputTokens = model.max_tokens
  return fields
}

/**
 * `path` overrides the one the SDK hardcodes for this resource; the caller
 * resolves it because only the adapter holds the provider's config.
 */
export async function listModels(
  client: Anthropic,
  ctx: ListModelsContext,
  path: string,
): Promise<DiscoveredModel[]> {
  const page = await client.models.list({}, { signal: ctx.signal, path } as never)
  const models: DiscoveredModel[] = []

  for await (const model of page as AsyncIterable<Record<string, unknown>>) {
    if (typeof model?.id !== 'string' || model.id.length === 0) continue
    models.push({ id: model.id, fields: catalogFields(model), raw: model })
  }

  return models
}
```

- [ ] **Step 4: Write `errors.ts`**

Copy `src/lib/adapters/openai/errors.ts` and change the SDK it interprets: `err instanceof Anthropic.APIError`, importing `Anthropic from '@anthropic-ai/sdk'`. Keep `RETRYABLE_STATUSES`, the 404-plus-hint rule, the abort handling and the comments explaining each — the reasoning is the same reasoning, and the file exists per-adapter for the reason `openai/errors.ts` states. Anthropic's error body has no `type` field the SDK surfaces the way OpenAI's does, so pass `code: err.name ?? null` rather than inventing one, and omit the `type` spread.

- [ ] **Step 5: Write `index.ts`**

```ts
import type Anthropic from '@anthropic-ai/sdk'
import {
  fromMessage,
  fromMessageStream,
  toMessagesRequest,
} from '@/lib/translate/chat-to-anthropic'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatOnlyAdapter,
  ProviderRuntime,
} from '../types'
import { resolveRequestPaths } from '../paths'
import { createAnthropicClient, listModels, type AnthropicClientFactory } from './client'
import { toProviderError } from './errors'

// Re-exported because tests and the registry import the factory type from the
// adapter module rather than reaching past it.
export type { AnthropicClientFactory }

// The counterpart to the two OpenAI-shaped hints: a model set to
// anthropic_messages whose endpoint in fact speaks an OpenAI dialect.
const FLAVOR_HINT =
  'If this endpoint does not implement the Anthropic Messages API, set the model\'s API flavor to "chat_completions" or "responses" on the Catalog page — or the provider\'s, if every model should follow it.'

/**
 * A provider that serves the Anthropic Messages API. It holds no translation
 * logic of its own — that lives in the pure module, which is what makes it
 * testable without a client — and satisfies the ChatOnlyAdapter contract, so
 * the registry gives it `respond`/`respondStream` from the same wrapper every
 * chat-only adapter uses and the routing loop never learns a fourth protocol
 * exists.
 *
 * `maxOutputTokens` is the model's catalogued ceiling, passed in because this
 * API requires `max_tokens` and Chat Completions does not. An adapter is
 * constructed per attempt and an attempt is always for one model, so it can be
 * closed over here rather than threaded through every call.
 */
export function createAnthropicAdapter(
  runtime: ProviderRuntime,
  maxOutputTokens: number | null = null,
  createClient?: AnthropicClientFactory,
): ChatOnlyAdapter {
  const client = createAnthropicClient(runtime, createClient)
  const paths = resolveRequestPaths(runtime.config, runtime.baseUrl)

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      try {
        const message = await client.messages.create(
          {
            ...toMessagesRequest(req, ctx.upstreamModel, runtime.config, maxOutputTokens),
            stream: false,
          },
          { signal: ctx.signal, path: paths.messages } as never,
        )
        return fromMessage(message as Anthropic.Message, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway has
      // committed a response, the second after. Both must arrive at the
      // routing loop already interpreted.
      let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>
      try {
        stream = await client.messages.create(
          {
            ...toMessagesRequest(req, ctx.upstreamModel, runtime.config, maxOutputTokens),
            stream: true,
          },
          { signal: ctx.signal, path: paths.messages } as never,
        ) as AsyncIterable<Anthropic.RawMessageStreamEvent>
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }

      try {
        yield* fromMessageStream(stream, req, ctx.upstreamModel)
      } catch (err) {
        throw toProviderError(err, FLAVOR_HINT)
      }
    },

    listModels: (ctx) => listModels(client, ctx, paths.models),
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/lib/adapters/anthropic`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add src/lib/adapters/anthropic tests/lib/adapters/anthropic
git commit  # feat(adapters): call a model on the Anthropic Messages API
```

---

### Task 9: Wire the flavor into the registry

**Files:**
- Modify: `src/lib/adapters/registry.ts`
- Modify: `tests/lib/adapters/registry.test.ts`

**Interfaces:**
- Consumes: `createAnthropicAdapter` (Task 8), `'anthropic_messages'` (Task 3), `ModelPathOverrides.messagesPath` (Task 2).
- Produces:

```ts
export function createAdapter(
  provider: ProviderRow,
  flavor?: ApiFlavor,
  paths?: ModelPathOverrides | null,
  maxOutputTokens?: number | null,
): ProviderAdapter
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/adapters/registry.test.ts`, following the file's existing fixtures for a `ProviderRow`:

```ts
test('an anthropic_messages model gets the Anthropic adapter, wrapped for respond', () => {
  const adapter = createAdapter(providerRow({ adapter: 'openai_compatible' }), 'anthropic_messages')
  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.respond).toBe('function')
})

test('the gemini adapter ignores an anthropic_messages flavor, as it ignores the others', () => {
  const adapter = createAdapter(providerRow({ adapter: 'gemini' }), 'anthropic_messages')
  expect(typeof adapter.chat).toBe('function')
})

test('an openai_compatible provider with no base URL is still refused', () => {
  expect(() => createAdapter(
    providerRow({ adapter: 'openai_compatible', baseUrl: null }),
    'anthropic_messages',
  )).toThrow(/no base URL/)
})
```

The model-path folding this task adds to `withModelPaths` is asserted where it is observable — Task 8's "a configured messages path resolves against the base URL origin" — rather than through `createAdapter`, which exposes no seam for injecting a client.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test tests/lib/adapters/registry.test.ts`
Expected: FAIL — the flavor is not handled.

- [ ] **Step 3: Add the branch and the fourth argument**

```ts
export function createAdapter(
  provider: ProviderRow,
  flavor: ApiFlavor = provider.apiFlavor,
  paths?: ModelPathOverrides | null,
  maxOutputTokens?: number | null,
): ProviderAdapter {
  const runtime = withModelPaths(resolveProviderRuntime(provider), paths)

  switch (runtime.adapter) {
    case 'openai':
      return flavoredAdapter(runtime, flavor, maxOutputTokens ?? null)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return flavoredAdapter(runtime, flavor, maxOutputTokens ?? null)
    // ... gemini and bedrock unchanged
  }
}
```

```ts
function withModelPaths(
  runtime: ProviderRuntime,
  paths: ModelPathOverrides | null | undefined,
): ProviderRuntime {
  if (!paths?.chatCompletionsPath && !paths?.responsesPath && !paths?.messagesPath) return runtime

  const config: ProviderConfig = { ...runtime.config }
  if (paths.chatCompletionsPath) config.chatCompletionsPath = paths.chatCompletionsPath
  if (paths.responsesPath) config.responsesPath = paths.responsesPath
  if (paths.messagesPath) config.messagesPath = paths.messagesPath
  return { ...runtime, config }
}
```

Rename `openAIShaped` to `flavoredAdapter` — it no longer returns only the OpenAI shape — and rewrite its comment:

```ts
/**
 * Dispatches on the flavor the model resolved to. Two of the three branches
 * need `withRespondViaChat`; the Responses adapter already implements
 * chat/chatStream through chat-to-responses.ts and is returned as-is.
 */
function flavoredAdapter(
  runtime: ProviderRuntime,
  flavor: ApiFlavor,
  maxOutputTokens: number | null,
): ProviderAdapter {
  if (flavor === 'responses') return createResponsesAdapter(runtime)
  if (flavor === 'anthropic_messages') {
    return withRespondViaChat(createAnthropicAdapter(runtime, maxOutputTokens), runtime.name)
  }
  return withRespondViaChat(createOpenAIAdapter(runtime), runtime.name)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/adapters/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add src/lib/adapters/registry.ts tests/lib/adapters/registry.test.ts
git commit  # feat(adapters): build the Anthropic adapter for an anthropic_messages model
```

---

### Task 10: Carry the model's ceiling and messages path through resolution

**Files:**
- Modify: `src/lib/gateway/resolve.ts`
- Modify: `src/lib/gateway/execute.ts` (the `ExecuteDeps.createAdapter` type and the call at `execute.ts:147`)
- Modify: `src/lib/gateway/handler.ts` (the `GatewayDeps.createAdapter` type)
- Modify: `tests/lib/gateway/resolve.test.ts`, `tests/lib/gateway/execute.test.ts`

**Interfaces:**
- Consumes: Task 3's `messagesPath` column, Task 9's `createAdapter` signature.
- Produces: `Candidate.maxOutputTokens: number | null` and `Candidate.pathOverrides.messagesPath`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/gateway/resolve.test.ts`, matching the file's existing seeding helpers:

```ts
test('a direct address carries the model ceiling and its messages path', async () => {
  const [provider] = await db.insert(providers).values({
    name: 'anthropic-test',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.anthropic.com/v1',
    credentials: encryptJson({ apiKey: 'sk-test' }),
  }).returning()
  await db.insert(catalogModels).values({
    providerId: provider.id,
    modelId: 'claude-opus-5',
    apiFlavor: 'anthropic_messages',
    maxOutputTokens: 64000,
    messagesPath: '/anthropic/v1/messages',
  })

  const { candidates } = await resolveModel('anthropic-test/claude-opus-5')
  expect(candidates[0].apiFlavor).toBe('anthropic_messages')
  expect(candidates[0].maxOutputTokens).toBe(64000)
  expect(candidates[0].pathOverrides?.messagesPath).toBe('/anthropic/v1/messages')
})

test('a target naming an uncatalogued model has no ceiling and no overrides', async () => {
  const { fast, model } = await seed()
  await db.insert(routeTargets).values({
    virtualModelId: model.id, providerId: fast.id, upstreamModel: 'never-catalogued',
  })

  const { candidates } = await resolveModel('house-model')
  expect(candidates[0].maxOutputTokens).toBeNull()
  expect(candidates[0].pathOverrides).toBeNull()
})
```

`seed()` is the file's existing helper, returning `{ fast, slow, model }`.

In `tests/lib/gateway/execute.test.ts`, add `maxOutputTokens: null` to the `candidate()` fixture (the type requires it) and assert the value reaches the factory. Note the argument order: `execute(chain, requestId, signal, deps, run)`.

```ts
test('execute passes the candidate ceiling to the adapter factory', async () => {
  const createAdapter = vi.fn().mockReturnValue(stubAdapter)
  const run = vi.fn().mockResolvedValue('body')
  const chain = [{ ...candidate('a'), maxOutputTokens: 64000 }]

  await execute(chain, 'req_1', live, { createAdapter }, run)

  expect(createAdapter).toHaveBeenCalledWith(
    expect.anything(), 'chat_completions', null, 64000,
  )
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test tests/lib/gateway/resolve.test.ts tests/lib/gateway/execute.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the field and the plumb**

In `src/lib/gateway/resolve.ts`, on `Candidate`:

```ts
  /** The model's catalogued output ceiling, or null when the catalog has
   *  none. Read only by the Anthropic adapter, whose dialect requires
   *  `max_tokens` to be stated even when the client sent none. */
  maxOutputTokens: number | null
```

Widen `modelPaths()` to read the third column and return it:

```ts
function modelPaths(
  catalog: {
    chatCompletionsPath: string | null
    responsesPath: string | null
    messagesPath: string | null
  } | null,
): ModelPathOverrides | null {
  if (!catalog) return null
  return {
    chatCompletionsPath: catalog.chatCompletionsPath,
    responsesPath: catalog.responsesPath,
    messagesPath: catalog.messagesPath,
  }
}
```

Set `maxOutputTokens: catalog?.maxOutputTokens ?? null` in `findVirtualModel`'s candidate map, and `maxOutputTokens: row.catalog.maxOutputTokens` in `resolveDirect`.

In `execute.ts` and `handler.ts`, widen the `createAdapter` dependency type to the four-argument form from Task 9, and pass the value at the call site:

```ts
      adapter = deps.createAdapter(
        candidate.provider,
        candidate.apiFlavor,
        candidate.pathOverrides,
        candidate.maxOutputTokens,
      )
```

Any test fixture that builds a `Candidate` by hand needs the new field; `tests/helpers/gateway.ts`'s `fakeAdapterDeps` takes no arguments and needs no change.

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/gateway`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add -A
git commit  # feat(gateway): carry a model's output ceiling and messages path to the adapter
```

---

### Task 11: One place decides what a candidate loses

**Files:**
- Modify: `src/lib/gateway/protocols/chat.ts`
- Modify: `src/lib/gateway/protocols/responses.ts`
- Create: `src/lib/gateway/protocols/dropped.ts`
- Create: `tests/lib/gateway/dropped-for-chat.test.ts`

**Interfaces:**
- Consumes: `droppedParams` from `chat-to-anthropic` (Task 7), `chat-to-gemini` and `chat-to-responses`.
- Produces: `export function droppedForChat(candidate: Candidate, req: ChatCompletionRequest): string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/gateway/dropped-for-chat.test.ts`:

```ts
import { expect, test } from 'vitest'
import { droppedForChat } from '@/lib/gateway/protocols/dropped'
import type { Candidate } from '@/lib/gateway/resolve'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function candidate(adapter: string, apiFlavor: string): Candidate {
  return {
    provider: { adapter } as Candidate['provider'],
    apiFlavor,
  } as Candidate
}

const req = {
  model: 'v', messages: [{ role: 'user', content: 'hi' }], seed: 7,
} as ChatCompletionRequest

test('a chat_completions candidate forwards the request as sent', () => {
  expect(droppedForChat(candidate('openai', 'chat_completions'), req)).toEqual([])
})

test('an anthropic_messages candidate reports what the Messages API cannot express', () => {
  expect(droppedForChat(candidate('openai_compatible', 'anthropic_messages'), req)).toContain('seed')
})

test('a gemini candidate is judged by its adapter, whatever flavor it carries', () => {
  const dropped = droppedForChat(candidate('gemini', 'anthropic_messages'), {
    ...req, logit_bias: { '1': 1 },
  } as ChatCompletionRequest)
  expect(dropped).toContain('logit_bias')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/lib/gateway/dropped-for-chat.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module and rewire both ingresses**

Create `src/lib/gateway/protocols/dropped.ts`:

```ts
import { droppedParams as anthropicDropped } from '@/lib/translate/chat-to-anthropic'
import { droppedParams as geminiDropped } from '@/lib/translate/chat-to-gemini'
import { droppedParams as responsesDropped } from '@/lib/translate/chat-to-responses'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type { Candidate } from '../resolve'

/**
 * What one candidate cannot express of a Chat Completions request.
 *
 * One function rather than a conditional per ingress: both ingresses reduce
 * to this question, the adapter check has to come before the flavor check
 * (Gemini's adapter translates regardless of flavor, having no native
 * endpoint to be native on), and duplicating that ordering is how it gets
 * broken.
 */
export function droppedForChat(candidate: Candidate, req: ChatCompletionRequest): string[] {
  if (candidate.provider.adapter === 'gemini') return geminiDropped(req)
  if (candidate.apiFlavor === 'responses') return responsesDropped(req)
  if (candidate.apiFlavor === 'anthropic_messages') return anthropicDropped(req)
  // A chat_completions candidate is sent the request as it arrived, so there
  // is nothing it can fail to express.
  return []
}
```

In `chat.ts`, replace the `droppedFor` conditional with `droppedFor: (candidate, req) => droppedForChat(candidate, req)` and drop the now-unused translator imports.

In `responses.ts`, keep the crossing losses and delegate the rest:

```ts
  droppedFor: (candidate, req) => {
    // A Responses-native candidate expresses everything it is sent; every
    // other one loses whatever responses-to-chat cannot carry, plus whatever
    // the candidate itself cannot express of the result.
    if (candidate.apiFlavor === 'responses' && candidate.provider.adapter !== 'gemini') return []
    return [...droppedParams(req), ...droppedForChat(candidate, toChatRequest(req))]
  },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/gateway/dropped-for-chat.test.ts tests/gateway/dropped-params.test.ts`
Expected: PASS. The existing dropped-params integration cases must still pass unchanged — if one changes meaning, the refactor is wrong, not the test.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add -A
git commit  # refactor(gateway): decide a candidate's dropped params in one place
```

---

### Task 12: The messages path in the admin surface

**Files:**
- Modify: `src/lib/admin/catalog.ts` (`CatalogListItem`, its builder, `ModelGatewayInput`, `setModelGateway`)
- Modify: `src/app/(admin)/catalog/actions.ts:139-141`
- Modify: `tests/lib/admin/catalog.test.ts`

**Interfaces:**
- Consumes: Task 2's `MODEL_PATH_FIELDS` and `parseProviderPath`, Task 3's column.
- Produces: `setModelGateway(id, { apiFlavor, chatCompletionsPath, responsesPath, messagesPath })`, and `CatalogListItem.messagesPath` plus `providerPaths.messagesPath`.

The dialog itself needs no edit: `catalog-forms.tsx` renders `MODEL_PATH_FIELDS` in a loop, so the input appears as soon as the field list has it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/admin/catalog.test.ts`. The file's existing gateway cases seed with `await seedCatalog(['gpt-4o'])` and then read `const [before] = await listCatalog()` — follow that exactly.

```ts
test('the Anthropic flavor and a messages path are stored on the model', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()

  await setModelGateway(before.id, {
    apiFlavor: 'anthropic_messages',
    messagesPath: 'anthropic/v1/messages/',
  })

  const [item] = await listCatalog()
  expect(item.apiFlavor).toBe('anthropic_messages')
  // parseProviderPath normalizes the missing leading slash and the trailing one.
  expect(item.messagesPath).toBe('/anthropic/v1/messages')
})

test('a blank messages path clears back to inheriting the provider', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()
  await setModelGateway(before.id, { messagesPath: '/m' })

  await setModelGateway(before.id, { messagesPath: '' })

  const [item] = await listCatalog()
  expect(item.messagesPath).toBeNull()
})

test('a full URL in the messages path is refused rather than saved', async () => {
  await seedCatalog(['gpt-4o'])
  const [before] = await listCatalog()

  await expect(setModelGateway(before.id, { messagesPath: 'https://elsewhere.test/v1/messages' }))
    .rejects.toThrow(/not a valid path/)

  const [item] = await listCatalog()
  expect(item.messagesPath).toBeNull()
})

test('the list item reports the provider messages path as the inherited placeholder', async () => {
  await seedCatalog(['gpt-4o'])
  const [item] = await listCatalog()
  expect(item.providerPaths.messagesPath).toBe('/messages')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test tests/lib/admin/catalog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Widen the admin layer**

In `src/lib/admin/catalog.ts`:

- add `messagesPath: string | null` to `CatalogListItem` beside `responsesPath`;
- widen `providerPaths` to `{ chatCompletionsPath: string; responsesPath: string; messagesPath: string }` in the interface, in the builder's parameter list, and where `resolveProviderPaths` is destructured (`const { chatCompletions, responses, messages } = resolveProviderPaths(...)`);
- add `messagesPath?: string | null` to `ModelGatewayInput`;
- add to `setModelGateway`, beside the other two:

```ts
  if (input.messagesPath !== undefined) {
    patch.messagesPath = parseProviderPath(input.messagesPath ?? '')
  }
```

In `src/app/(admin)/catalog/actions.ts`, add to the `setModelGateway` call:

```ts
      messagesPath: String(formData.get('messagesPath') ?? ''),
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/lib/admin`
Expected: PASS.

- [ ] **Step 5: See it in the browser**

Start the dashboard against the disposable database — **never `pnpm dev`**, which points at the developer's own Postgres on 5432:

```bash
pnpm dev:test-db   # serves http://localhost:3001
```

Open `/catalog`, open a model's ⋮ → Gateway settings…, and confirm the flavor select offers **Anthropic Messages** and a **Messages path** input sits beside the other two with `/messages` as its placeholder. Then stop the server.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add -A
git commit  # feat(catalog): set a model's Anthropic Messages path from the admin UI
```

---

### Task 13: Copy that names two flavors where there are three

**Files:**
- Modify: `src/lib/adapters/openai/index.ts` (`FLAVOR_HINT`)
- Modify: `src/lib/adapters/openai/responses.ts` (`FLAVOR_HINT`)
- Modify: `README.md` (the flavor section around line 57 and 115-126, and the adapter table)

**Interfaces:**
- Consumes: nothing.
- Produces: no code interface — copy only.

- [ ] **Step 1: Update the two hints**

Each currently names the one alternative flavor. Each should name both, e.g. in `openai/index.ts`:

```ts
const FLAVOR_HINT =
  'If this endpoint implements the Responses API or the Anthropic Messages API instead, set the model\'s API flavor accordingly on the Catalog page — or the provider\'s, if every model should follow it.'
```

and the symmetric change in `openai/responses.ts`.

- [ ] **Step 2: Update the README**

- The adapter table rows for `openai` and `openai_compatible` gain the third flavor.
- The paragraph explaining that a provider is called on "one of those two APIs" becomes three.
- Add a short paragraph: an `anthropic_messages` model is called on `/v1/messages`; clients keep speaking Chat Completions or the Responses API and the gateway translates both ways; `x-babellm-dropped-params` reports what a request lost; there is no client-facing `/v1/messages` endpoint.

- [ ] **Step 3: Check nothing stale is left**

Run: `grep -rn "two flavors\|both flavors\|API flavor" README.md src --include=*.ts --include=*.tsx`
Expected: every hit either already names three flavors or is flavor-agnostic.

- [ ] **Step 4: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test tests/lib/adapters`

```bash
git add -A
git commit  # docs: describe the Anthropic Messages flavor beside the other two
```

---

### Task 14: End-to-end through the gateway

**Files:**
- Modify: `tests/helpers/gateway.ts` (`TargetSpec.messagesPath`)
- Modify: `tests/gateway/mixed-flavor.test.ts`
- Modify: `tests/gateway/dropped-params.test.ts`
- Modify: `tests/contract/openai-client.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: proof that a client speaking either OpenAI dialect is served by a model on the Anthropic flavor.

- [ ] **Step 1: Extend the seeding helper**

In `tests/helpers/gateway.ts`, add `messagesPath?: string | null` to `TargetSpec`, add it to the condition that decides whether a `catalog_models` row is written, and write it onto that row:

```ts
    if (spec.apiFlavor || spec.chatCompletionsPath || spec.responsesPath || spec.messagesPath) {
      await db.insert(catalogModels).values({
        providerId: provider.id,
        modelId: `${spec.name}-model`,
        apiFlavor: spec.apiFlavor ?? null,
        chatCompletionsPath: spec.chatCompletionsPath ?? null,
        responsesPath: spec.responsesPath ?? null,
        messagesPath: spec.messagesPath ?? null,
      })
    }
```

- [ ] **Step 2: Write the failing integration tests**

In `tests/gateway/mixed-flavor.test.ts`, add a helper beside the file's existing `responsesAdapter` that builds the **real** Anthropic adapter over a stub client — the point of these cases is that translation actually runs — and then the cases below. `runtime(name)` already exists in the file; give it `baseUrl: 'https://api.anthropic.com/v1'` for this helper by spreading over it.

```ts
import { createAnthropicAdapter } from '@/lib/adapters/anthropic'

/** A real Anthropic adapter over a fake SDK client, wrapped exactly as the
 *  registry wraps it, so both ingresses exercise the real crossings. */
function anthropicAdapter(name: string, create: unknown): ProviderAdapter {
  const factory = vi.fn().mockReturnValue({ messages: { create } })
  return withRespondViaChat(
    createAnthropicAdapter(
      { ...runtime(name), baseUrl: 'https://api.anthropic.com/v1' },
      null,
      factory as never,
    ),
    name,
  )
}

function anthropicMessage(text: string) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  }
}

test('a Chat Completions client is served by an anthropic_messages model', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' }],
  })
  const create = vi.fn().mockResolvedValue(anthropicMessage('from anthropic'))
  const deps = fakeAdapterByProvider({ claude: anthropicAdapter('claude', create) })

  const res = await handleChatCompletions(chatRequest(body, apiKey), deps)

  expect(res.status).toBe(200)
  await expect(res.json()).resolves.toMatchObject({
    choices: [{ message: { content: 'from anthropic' } }],
  })
  // The upstream saw a Messages request, not a Chat Completions one.
  expect(create.mock.calls[0][0].messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ])
})

test('a Responses client reaches the same model through the double crossing', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' }],
  })
  const create = vi.fn().mockResolvedValue(anthropicMessage('crossed twice'))
  const deps = fakeAdapterByProvider({ claude: anthropicAdapter('claude', create) })

  const res = await handleResponses(
    responsesRequest({ model: 'house-model', input: 'hi' }, apiKey),
    deps,
  )

  expect(res.status).toBe(200)
  await expect(res.json()).resolves.toMatchObject({
    status: 'completed',
    output: [{ content: [{ text: 'crossed twice' }] }],
  })
})

test("the model's thinking reaches a Responses client as a reasoning summary", async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages' }],
  })
  async function* events() {
    yield {
      type: 'message_start',
      message: {
        id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 0 },
      },
    }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing' } }
    yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }
  }
  const create = vi.fn().mockResolvedValue(events())
  const deps = fakeAdapterByProvider({ claude: anthropicAdapter('claude', create) })

  const res = await handleResponses(
    responsesRequest(
      { model: 'house-model', input: 'hi', stream: true, reasoning: { effort: 'high' } },
      apiKey,
    ),
    deps,
  )

  const chunks = await parseSseChunks(res)
  const types = chunks.map((c) => (c as { type?: string }).type)
  expect(types).toContain('response.reasoning_summary_text.delta')
  expect(types).toContain('response.output_text.delta')
  // The thinking the client asked for was actually requested upstream.
  expect(create.mock.calls[0][0].thinking).toEqual({ type: 'adaptive', display: 'summarized' })
})

test('failover crosses flavors: an anthropic target fails, a chat target serves', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'claude', adapter: 'openai_compatible', apiFlavor: 'anthropic_messages', priority: 1 },
      { name: 'openai-fallback', apiFlavor: 'chat_completions', priority: 2 },
    ],
  })
  const create = vi.fn().mockRejectedValue(apiError(503, 'overloaded'))
  const deps = fakeAdapterByProvider({
    claude: anthropicAdapter('claude', create),
    'openai-fallback': { chat: async () => completion('openai-fallback') as never },
  })

  const res = await handleChatCompletions(chatRequest(body, apiKey), deps)

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('openai-fallback')
})
```

`apiError` in the failover case is the file's existing OpenAI-shaped helper; the Anthropic adapter's error classifier reads any non-`Anthropic.APIError` as a retryable 502, which is enough to move the chain on. If you prefer the exact status, build an `Anthropic.APIError(503, …)` instead.

In `tests/gateway/dropped-params.test.ts`, following that file's existing cases:

```ts
test('a pinned service tier is reported as dropped by an anthropic_messages model', async () => {
  const { apiKey } = await seedTargets({
    targets: [{
      name: 'claude', adapter: 'openai_compatible',
      apiFlavor: 'anthropic_messages', serviceTier: 'flex',
    }],
  })
  const deps = fakeAdapterByProvider({ claude: { chat: async () => completion() as never } })

  const res = await handleChatCompletions(chatRequest(body, apiKey), deps)

  expect(res.headers.get('x-babellm-dropped-params')?.split(',')).toContain('service_tier')
})
```

In `tests/contract/openai-client.test.ts`, add a case in the shape the file already uses — a real `OpenAI` client whose `fetch` is pointed at the gateway handler — for a virtual model whose target is on the Anthropic flavor, asserting the client parses `choices[0].message.content`. Reuse `anthropicMessage` by exporting it from a shared spot or duplicating the four-line literal; do not add a new fixture file for it.

- [ ] **Step 3: Run them**

Run: `pnpm test tests/gateway tests/contract`
Expected: PASS. If the double-crossing case fails on `assertServiceable`, the Responses request in the test is asking for a hosted tool or conversation state — that refusal is correct behaviour; change the test's request, not the code.

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: the whole suite green. Report the actual output — do not claim completion without it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit  # test(gateway): serve both ingresses from a model on the Anthropic flavor
```

---

## Done means

- `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass, with output shown.
- A model set to **Anthropic Messages** in the catalog dialog serves both `/v1/chat/completions` and `/v1/responses`, streaming and not, with tools and with thinking.
- `x-babellm-dropped-params` names what a request lost crossing to the Messages API.
- No client-facing `/v1/messages` route exists — that was deliberately left out.
