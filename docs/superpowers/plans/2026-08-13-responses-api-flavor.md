# Responses API Flavor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a provider be marked as speaking the Responses API instead of Chat Completions, and serve it through the existing `/v1/chat/completions` endpoint by translating in both directions.

**Architecture:** An `api_flavor` column on `providers` selects, in `createAdapter`, between today's `createOpenAIAdapter` and a new `createResponsesAdapter`. Both satisfy the unchanged `ProviderAdapter` interface, so routing, failover, SSE framing and identity rewriting never learn that two protocols exist. All translation lives in one pure module, `src/lib/translate/chat-to-responses.ts`, which holds the request-out and result-in halves of a single round trip together because they share an invariant: a client's `tool_calls[].id` goes upstream as `call_id` and must come back unchanged.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, drizzle-orm 0.45 on node-postgres, `openai` 7.4 SDK (`client.responses`), Vitest 4 against a real Postgres.

**Spec:** `docs/superpowers/specs/2026-08-13-responses-api-flavor-design.md`

## Global Constraints

- **This is not the Next.js you know.** Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before writing App Router or server-action code. Task 9 is the only task that touches App Router code.
- **One migration, in Task 1 only.** `drizzle-kit generate` is run exactly once, in Task 1. No other task may edit `src/lib/db/schema.ts` or add a migration.
- **No new dependencies.** Nothing may be added to `package.json`. `client.responses` already exists in the pinned `openai@7.4.0` — verify with `ls node_modules/openai/resources/responses/` if in doubt.
- **`ProviderAdapter` does not change.** Do not add `respond`, `respondStream`, or a stub for either. The `/v1/responses` ingress is spec §8, a later phase. A task that changes `src/lib/adapters/types.ts`'s `ProviderAdapter` interface is wrong.
- **No `/v1/responses` route.** Do not create `src/app/v1/responses/`.
- **No `src/lib/translate/responses-to-chat.ts`.** That is the mirror module for the later phase.
- **Never reject a request because of a flavor difference.** Per spec §3.4, unmappable parameters are dropped and reported, never fatal. A task that throws or 400s on `n`, `stop`, `logprobs` or similar is wrong.
- **`store: false` always.** No `previous_response_id`, no `conversation`, no `store: true` under any condition.
- **Tests run against a real database.** `pnpm test` needs Postgres up (`docker compose up -d`). Test files run serially by design (`vitest.config.ts`).
- **Run tests with the file path**, e.g. `pnpm test tests/lib/translate/chat-to-responses.test.ts`. `pnpm test` alone runs everything.
- **Commit after every task.** Each task ends with a working tree that passes `pnpm test` and `pnpm lint`.
- **`AGENTS.md` churn:** `next dev` rewrites a block in `AGENTS.md`. If it shows up dirty, commit it with your work rather than reverting it.
- **Comment style:** this codebase writes comments that explain *why*, in full sentences, above the code they describe. Match it. Do not add narrating comments that restate the line below them.
- **Existing tests must stay green.** `tests/lib/adapters/openai/{chat,stream,models,errors}.test.ts`, `tests/gateway/*.test.ts` and `tests/contract/openai-client.test.ts` must keep passing. Only Task 2 and Task 8 may modify existing test files, and only as those tasks describe.
- **Two files are already dirty** in the working tree (`src/app/(admin)/models/[id]/settings-form.tsx`, `src/app/(admin)/models/page.tsx`) from unrelated work. Leave them alone; do not `git add -A`. Stage the exact paths each commit step names.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/db/schema.ts` | `apiFlavorEnum` and `providers.apiFlavor`. |
| `src/lib/adapters/types.ts` | `apiFlavors` / `ApiFlavor`; `ProviderRuntime.apiFlavor`; `ProviderConfig.requestReasoningSummary`. `ProviderAdapter` unchanged. |
| `src/lib/adapters/registry.ts` | `resolveApiFlavor()` — the single read point for flavor — and the branch that picks an adapter. |
| `src/lib/adapters/openai/client.ts` (new) | `createOpenAIClient()` and `listModels()`, shared by both adapters. Extracted, not rewritten. |
| `src/lib/adapters/openai/index.ts` | The Chat Completions adapter, now consuming the shared client. |
| `src/lib/adapters/openai/responses.ts` (new) | The Responses adapter. Holds no translation logic — it is the seam between an SDK client and the pure module. |
| `src/lib/adapters/openai/errors.ts` | `toProviderError()` gains an optional hint appended only on a 404. |
| `src/lib/translate/chat-to-responses.ts` (new) | The whole round trip: `toResponsesRequest`, `fromResponse`, `fromResponseStream`, `droppedParams`. Pure — no client, no network, no database. |
| `src/lib/schemas/chat.ts` | `reasoning_effort` added, because the translator now reads it. |
| `src/lib/gateway/chat-handler.ts` | Computes dropped parameters for the winning candidate; passes them to the header and the log. |
| `src/lib/gateway/request-log.ts` | `dropped_params` on the log line. |
| `src/lib/admin/providers.ts` | `apiFlavor` on `ProviderInput` and `ProviderListItem`. |
| `src/app/(admin)/providers/*` | Flavor select on create and edit, badge on the list, form parsing in the action. |

Tests mirror the source tree: `tests/lib/translate/chat-to-responses.test.ts`, `tests/lib/adapters/openai/responses-{chat,stream}.test.ts`, additions to `tests/lib/adapters/registry.test.ts`, `tests/lib/db/schema.test.ts`, `tests/lib/gateway/request-log.test.ts`, `tests/lib/admin/providers.test.ts`, and new gateway/contract cases.

**Task order matters.** Tasks 3–5 build the translator bottom-up and each leaves the tree green. Task 6 is the first task where a Responses provider can actually serve a request.

---

### Task 1: The `api_flavor` column and its single read point

Adds the column and the one function everything else reads it through. Nothing branches on it yet — `createAdapter` still returns the Chat Completions adapter for every provider, so behaviour is unchanged and every existing test stays green.

`resolveApiFlavor` looks trivial, and that is deliberate: it is the seam spec §3.1 promises, so that adding a per-model layer later changes one function body instead of a scatter of call sites. Do not inline it.

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0002_*.sql` (generated)
- Modify: `src/lib/adapters/types.ts`
- Modify: `src/lib/adapters/registry.ts:7-16`
- Modify: `tests/helpers/gateway.ts`
- Test: `tests/lib/db/schema.test.ts` (append)
- Test: `tests/lib/adapters/registry.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `apiFlavors: readonly ['chat_completions', 'responses']` and `type ApiFlavor` from `@/lib/adapters/types`
  - `resolveApiFlavor(provider: ProviderRow): ApiFlavor` from `@/lib/adapters/registry`
  - `ProviderRuntime.apiFlavor: ApiFlavor`
  - `ProviderConfig.requestReasoningSummary?: boolean`
  - `SeedOptions.apiFlavor?: ApiFlavor` and `TargetSpec.apiFlavor?: ApiFlavor` in `tests/helpers/gateway.ts`

- [ ] **Step 1: Add the enum and column**

In `src/lib/db/schema.ts`, beside the other enums:

```ts
export const apiFlavorEnum = pgEnum('api_flavor', ['chat_completions', 'responses'])
```

And in the `providers` table, directly after `config`:

```ts
  config: text('config').notNull().default('{}'),
  // Which upstream protocol this provider speaks. A column rather than a
  // `config` key because it decides whether a request can be served at all,
  // which is the same class of fact as `adapter` and `base_url`.
  apiFlavor: apiFlavorEnum('api_flavor').notNull().default('chat_completions'),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`

Expected: a new `drizzle/0002_*.sql` containing `CREATE TYPE "public"."api_flavor"` and an `ALTER TABLE "providers" ADD COLUMN "api_flavor"` with the default. Open it and confirm there is no `DROP` statement — if there is, the schema edit was wrong.

Then apply it: `pnpm db:migrate`

- [ ] **Step 3: Add the flavor type and runtime field**

In `src/lib/adapters/types.ts`, above `ProviderConfig`:

```ts
export const apiFlavors = ['chat_completions', 'responses'] as const
export type ApiFlavor = (typeof apiFlavors)[number]
```

Add to `ProviderConfig`:

```ts
  /**
   * Ask a Responses-flavored provider for reasoning summaries even when the
   * client did not send `reasoning_effort`. Off by default: sending `reasoning`
   * to a model that does not reason is an error on OpenAI-shaped endpoints,
   * and the gateway cannot tell which kind of model it is addressing.
   */
  requestReasoningSummary?: boolean
```

Add to `ProviderRuntime`:

```ts
  apiFlavor: ApiFlavor
```

**Do not touch `ProviderAdapter`.**

- [ ] **Step 4: Write the failing tests**

Append to `tests/lib/db/schema.test.ts`:

```ts
test('a provider defaults to the chat_completions flavor', async () => {
  const [row] = await db.insert(providers).values({
    name: 'legacy', adapter: 'openai', credentials: encryptJson({ apiKey: 'a' }),
  }).returning()

  expect(row.apiFlavor).toBe('chat_completions')
})

test('a provider can be stored with the responses flavor', async () => {
  const [row] = await db.insert(providers).values({
    name: 'resp', adapter: 'openai_compatible', baseUrl: 'https://api.example/v1',
    credentials: encryptJson({ apiKey: 'a' }), apiFlavor: 'responses',
  }).returning()

  expect(row.apiFlavor).toBe('responses')
})
```

Append to `tests/lib/adapters/registry.test.ts`:

```ts
test('resolveApiFlavor defaults to chat_completions', () => {
  expect(resolveApiFlavor(provider())).toBe('chat_completions')
})

test('resolveApiFlavor reads the stored flavor', () => {
  expect(resolveApiFlavor(provider({ apiFlavor: 'responses' }))).toBe('responses')
})

test('resolveProviderRuntime carries the flavor onto the runtime', () => {
  expect(resolveProviderRuntime(provider({ apiFlavor: 'responses' })).apiFlavor)
    .toBe('responses')
})
```

Extend that file's import to `import { createAdapter, resolveApiFlavor, resolveProviderRuntime } from '@/lib/adapters/registry'`, and add `apiFlavor: 'chat_completions',` to the `provider()` factory's defaults so the cast keeps matching `ProviderRow`.

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm test tests/lib/adapters/registry.test.ts tests/lib/db/schema.test.ts`
Expected: FAIL — `resolveApiFlavor is not a function`.

- [ ] **Step 6: Implement `resolveApiFlavor`**

In `src/lib/adapters/registry.ts`:

```ts
/**
 * The single place flavor is decided. It reads one column today, but every
 * caller goes through it so that a per-model layer — which the catalog could
 * supply — lands here rather than in each call site.
 */
export function resolveApiFlavor(provider: ProviderRow): ApiFlavor {
  return provider.apiFlavor
}
```

And in `resolveProviderRuntime`, add `apiFlavor: resolveApiFlavor(provider),` to the returned object. Import `ApiFlavor` from `./types`.

- [ ] **Step 7: Teach the test helpers about flavor**

Task 7 reads the flavor off the real provider row, so seeded providers must be able to carry one.

In `tests/helpers/gateway.ts`, add `apiFlavor?: ApiFlavor` to both `SeedOptions` and `TargetSpec` (importing the type from `@/lib/adapters/types`), and pass it through both inserts:

```ts
  const [provider] = await db.insert(providers).values({
    name: 'test-provider',
    adapter: options.adapter ?? 'openai',
    credentials: encryptJson(options.credentials ?? { apiKey: 'sk-upstream' }),
    apiFlavor: options.apiFlavor ?? 'chat_completions',
  }).returning()
```

```ts
    const [provider] = await db.insert(providers).values({
      name: spec.name,
      adapter: spec.adapter ?? 'openai',
      credentials: encryptJson({ apiKey: `sk-${spec.name}` }),
      apiFlavor: spec.apiFlavor ?? 'chat_completions',
    }).returning()
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test tests/lib/adapters/registry.test.ts tests/lib/db/schema.test.ts`
Expected: PASS

Then the whole suite, to confirm the column changed nothing: `pnpm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/lib/db/schema.ts drizzle src/lib/adapters/types.ts src/lib/adapters/registry.ts tests/helpers/gateway.ts tests/lib/db/schema.test.ts tests/lib/adapters/registry.test.ts
git commit -m "feat(providers): add an api_flavor column and its single read point"
```

---

### Task 2: Extract the shared OpenAI client and `listModels`

A pure refactor with no behaviour change. Both adapters need the same client construction and the same `listModels` — `GET /v1/models` is a third endpoint that both kinds of provider serve, which is why the catalog needs no changes at all. Extracting now means Task 6 shares them instead of copy-pasting them.

Every existing test in `tests/lib/adapters/openai/` must pass unmodified after this task. If one needs editing, the extraction changed behaviour and is wrong.

**Files:**
- Create: `src/lib/adapters/openai/client.ts`
- Modify: `src/lib/adapters/openai/index.ts`

**Interfaces:**
- Consumes: `ProviderRuntime` (Task 1).
- Produces, from `@/lib/adapters/openai/client`:
  - `type OpenAIClientFactory = (opts: ClientOptions) => OpenAI`
  - `createOpenAIClient(runtime: ProviderRuntime, factory?: OpenAIClientFactory): OpenAI`
  - `listModels(client: OpenAI, ctx: ListModelsContext): Promise<DiscoveredModel[]>`

- [ ] **Step 1: Create the shared module**

`src/lib/adapters/openai/client.ts`:

```ts
import OpenAI, { type ClientOptions } from 'openai'
import type {
  DiscoveredModel,
  ListModelsContext,
  ProviderRuntime,
} from '../types'

export type OpenAIClientFactory = (opts: ClientOptions) => OpenAI

const defaultFactory: OpenAIClientFactory = (opts) => new OpenAI(opts)

interface OpenAICredentials {
  apiKey?: string
  organization?: string
  project?: string
}

/**
 * Both flavors authenticate identically and differ only in which endpoint they
 * call, so client construction is shared rather than duplicated per adapter.
 */
export function createOpenAIClient(
  runtime: ProviderRuntime,
  factory: OpenAIClientFactory = defaultFactory,
): OpenAI {
  const credentials = runtime.credentials as OpenAICredentials
  if (!credentials.apiKey) {
    throw new Error(`Provider "${runtime.name}" is missing an apiKey credential.`)
  }

  return factory({
    apiKey: credentials.apiKey,
    ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    ...(credentials.organization ? { organization: credentials.organization } : {}),
    ...(credentials.project ? { project: credentials.project } : {}),
    maxRetries: 0,
  })
}

/**
 * `GET /v1/models` is a third endpoint, served by Chat Completions and
 * Responses providers alike, so model discovery is identical for both flavors
 * and the catalog never has to know which one it is talking to.
 */
export async function listModels(
  client: OpenAI,
  ctx: ListModelsContext,
): Promise<DiscoveredModel[]> {
  const page = await client.models.list({ signal: ctx.signal })
  const models: DiscoveredModel[] = []

  for await (const model of page) {
    // Some openai_compatible clones return entries with no id at all.
    if (typeof model?.id !== 'string' || model.id.length === 0) continue
    // /v1/models reports id, created and owned_by — nothing the catalog
    // can merge. Enrichment comes from the registry and seed layers.
    models.push({ id: model.id, fields: {}, raw: model })
  }

  return models
}
```

- [ ] **Step 2: Rewrite `index.ts` to consume it**

`src/lib/adapters/openai/index.ts` keeps `createOpenAIAdapter` and `upstreamParams`, and loses the credential handling, the factory and the `listModels` body:

```ts
import type OpenAI from 'openai'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'
import type {
  AttemptContext,
  ChatCompletion,
  ChatCompletionChunk,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'
import { createOpenAIClient, listModels, type OpenAIClientFactory } from './client'
import { toProviderError } from './errors'

// Re-exported because tests and the registry import the factory type from the
// adapter module rather than reaching past it.
export type { OpenAIClientFactory }

export function createOpenAIAdapter(
  runtime: ProviderRuntime,
  createClient?: OpenAIClientFactory,
): ProviderAdapter {
  const client = createOpenAIClient(runtime, createClient)

  function upstreamParams(req: ChatCompletionRequest, ctx: AttemptContext) {
    return { ...req, model: ctx.upstreamModel }
  }

  return {
    // chat, chatStream: unchanged from the current file, body for body.
    // ...
    listModels: (ctx) => listModels(client, ctx),
  }
}
```

Keep the existing `chat` and `chatStream` bodies exactly as they are, including their comments. The only edits are the imports, the removal of the local factory/credential code, and `listModels` delegating.

- [ ] **Step 3: Run the adapter tests unmodified**

Run: `pnpm test tests/lib/adapters/openai/`
Expected: PASS, with no test file edited. `tests/lib/adapters/openai/models.test.ts` and `chat.test.ts` both exercise the extracted code paths, including the missing-`apiKey` throw.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/adapters/openai/client.ts src/lib/adapters/openai/index.ts
git commit -m "refactor(adapters): share OpenAI client construction and listModels"
```

---

### Task 3: Translate a Chat Completions request into a Responses request

The first half of the round trip, plus the dropped-parameter report. Pure functions — no client, no network.

One refinement on spec §3.4 worth stating: parameters whose value is *inert* are not reported. `n: 1`, `frequency_penalty: 0` and `presence_penalty: 0` are what SDKs and frameworks send by default and mean nothing by, so reporting them would fill the header on every request and bury the two cases that actually change the answer. The spec's goal is that a silently changed result is discoverable; an inert default is not a changed result.

**Files:**
- Create: `src/lib/translate/chat-to-responses.ts`
- Modify: `src/lib/schemas/chat.ts`
- Test: `tests/lib/translate/chat-to-responses.test.ts` (new)
- Test: `tests/lib/schemas/chat.test.ts` (append)

**Interfaces:**
- Consumes: `ProviderConfig` (Task 1), `ChatCompletionRequest`.
- Produces, from `@/lib/translate/chat-to-responses`:
  - `toResponsesRequest(req: ChatCompletionRequest, upstreamModel: string, config?: ProviderConfig): OpenAI.Responses.ResponseCreateParams`
  - `droppedParams(req: ChatCompletionRequest): string[]`

- [ ] **Step 1: Add `reasoning_effort` to the request schema**

In `src/lib/schemas/chat.ts`, inside `chatCompletionRequestSchema` after `top_p`:

```ts
  // Typed as a free string rather than an enum: the translator only needs to
  // know whether the client is addressing a reasoning model, and new effort
  // tiers appear faster than this schema would be updated.
  reasoning_effort: z.string().nullable().optional(),
```

- [ ] **Step 2: Write the failing tests**

`tests/lib/translate/chat-to-responses.test.ts`:

```ts
import { expect, test } from 'vitest'
import { droppedParams, toResponsesRequest } from '@/lib/translate/chat-to-responses'
import type { ChatCompletionRequest } from '@/lib/schemas/chat'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'house-model',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
}

test('substitutes the upstream model and pins store to false', () => {
  const params = toResponsesRequest(request(), 'gpt-5-mini')
  expect(params.model).toBe('gpt-5-mini')
  expect(params.store).toBe(false)
})

test('system and developer messages keep their role and position', () => {
  const params = toResponsesRequest(
    request({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'developer', content: 'use json' },
      ],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'developer', content: 'use json' },
  ])
})

test('content parts become input_text and input_image', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'low' } },
        ],
      }],
    }),
    'm',
  )

  expect(params.input).toEqual([{
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'https://x/y.png', detail: 'low' },
    ],
  }])
})

test('an image without a detail defaults to auto', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
      }],
    }),
    'm',
  )

  expect((params.input as never[])[0]).toMatchObject({
    content: [{ type: 'input_image', detail: 'auto' }],
  })
})

test('assistant tool calls become function_call items carrying the call id', () => {
  const params = toResponsesRequest(
    request({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' },
      ],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'user', content: 'weather?' },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
  ])
})

test('an assistant message with both text and tool calls emits both, text first', () => {
  const params = toResponsesRequest(
    request({
      messages: [{
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{
          id: 'call_9', type: 'function',
          function: { name: 'f', arguments: '{}' },
        }],
      }],
    }),
    'm',
  )

  expect(params.input).toEqual([
    { role: 'assistant', content: 'let me check' },
    { type: 'function_call', call_id: 'call_9', name: 'f', arguments: '{}' },
  ])
})

test('tools flatten out of their function wrapper', () => {
  const params = toResponsesRequest(
    request({
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'look up weather',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
      }],
    }),
    'm',
  )

  expect(params.tools).toEqual([{
    type: 'function',
    name: 'get_weather',
    description: 'look up weather',
    parameters: { type: 'object', properties: {} },
    strict: true,
  }])
})

test('a named tool_choice flattens the same way', () => {
  const params = toResponsesRequest(
    request({ tool_choice: { type: 'function', function: { name: 'f' } } }),
    'm',
  )
  expect(params.tool_choice).toEqual({ type: 'function', name: 'f' })
})

test('a string tool_choice passes through', () => {
  expect(toResponsesRequest(request({ tool_choice: 'required' }), 'm').tool_choice)
    .toBe('required')
})

test('max_completion_tokens wins over max_tokens', () => {
  const params = toResponsesRequest(
    request({ max_tokens: 10, max_completion_tokens: 99 }),
    'm',
  )
  expect(params.max_output_tokens).toBe(99)
})

test('max_tokens is used when max_completion_tokens is absent', () => {
  expect(toResponsesRequest(request({ max_tokens: 10 }), 'm').max_output_tokens).toBe(10)
})

test('a json_schema response format flattens into text.format', () => {
  const params = toResponsesRequest(
    request({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
    } as never),
    'm',
  )

  expect(params.text).toEqual({
    format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true },
  })
})

test('a json_object response format maps to text.format', () => {
  const params = toResponsesRequest(
    request({ response_format: { type: 'json_object' } }),
    'm',
  )
  expect(params.text).toEqual({ format: { type: 'json_object' } })
})

test('user maps to safety_identifier', () => {
  expect(toResponsesRequest(request({ user: 'u-1' }), 'm').safety_identifier).toBe('u-1')
})

test('reasoning is not requested when the client gave no reasoning_effort', () => {
  expect(toResponsesRequest(request(), 'm').reasoning).toBeUndefined()
})

test('reasoning_effort asks for a summary alongside the effort', () => {
  const params = toResponsesRequest(request({ reasoning_effort: 'high' } as never), 'm')
  expect(params.reasoning).toEqual({ effort: 'high', summary: 'auto' })
})

test('the provider config can request summaries without a client hint', () => {
  const params = toResponsesRequest(request(), 'm', { requestReasoningSummary: true })
  expect(params.reasoning).toEqual({ summary: 'auto' })
})

test('unmappable parameters never appear in the upstream request', () => {
  const params = toResponsesRequest(
    request({ n: 3, stop: ['\n'], seed: 7, frequency_penalty: 0.5 } as never),
    'm',
  )

  for (const key of ['n', 'stop', 'seed', 'frequency_penalty']) {
    expect(params).not.toHaveProperty(key)
  }
})

test('droppedParams names the parameters that were discarded', () => {
  expect(droppedParams(request({ n: 3, stop: ['\n'], seed: 7 } as never)).sort())
    .toEqual(['n', 'seed', 'stop'])
})

test('droppedParams stays silent about inert defaults', () => {
  expect(droppedParams(request({
    n: 1, frequency_penalty: 0, presence_penalty: 0, temperature: 0.7,
  } as never))).toEqual([])
})

test('droppedParams reports audio content parts', () => {
  const dropped = droppedParams(request({
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }],
    }],
  } as never))

  expect(dropped).toContain('audio_content')
})

test('a request with nothing unmappable drops nothing', () => {
  expect(droppedParams(request({ temperature: 0.2, top_p: 1 }))).toEqual([])
})
```

Append to `tests/lib/schemas/chat.test.ts`:

```ts
test('reasoning_effort is accepted', () => {
  const parsed = chatCompletionRequestSchema.parse({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  })
  expect(parsed.reasoning_effort).toBe('high')
})
```

Check that file's existing import name for the schema and match it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/lib/translate/chat-to-responses.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement the request translator**

`src/lib/translate/chat-to-responses.ts`:

```ts
import type OpenAI from 'openai'
import type { ProviderConfig } from '@/lib/adapters/types'
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
    if (name in INERT && value === INERT[name]) continue
    dropped.push(name)
  }

  if (hasAudioPart(req)) dropped.push('audio_content')
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
    if (message.role === 'tool' || message.role === 'function') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: textOf(message.content),
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/lib/translate/chat-to-responses.test.ts tests/lib/schemas/chat.test.ts`
Expected: PASS

- [ ] **Step 6: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/translate/chat-to-responses.ts src/lib/schemas/chat.ts tests/lib/translate/chat-to-responses.test.ts tests/lib/schemas/chat.test.ts
git commit -m "feat(translate): map a Chat Completions request onto the Responses API"
```

---

### Task 4: Translate a Responses result back into a ChatCompletion

The return half for non-streaming requests. Same file, because it undoes what Task 3 did.

**Files:**
- Modify: `src/lib/translate/chat-to-responses.ts`
- Test: `tests/lib/translate/chat-to-responses.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 3 beyond the module itself.
- Produces: `fromResponse(res: OpenAI.Responses.Response): ChatCompletion`, plus an internal `finishReason` and `toUsage` reused by Task 5.

- [ ] **Step 1: Write the failing tests**

Extend the existing top-of-file import to `import { droppedParams, fromResponse, toResponsesRequest } from '@/lib/translate/chat-to-responses'` — do not add a second import statement lower down — then append:

```ts
function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1700000000,
    model: 'gpt-5-mini',
    status: 'completed',
    incomplete_details: null,
    output: [],
    ...overrides,
  } as never
}

const usage = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 8, cache_write_tokens: 0 },
  output_tokens: 12,
  output_tokens_details: { reasoning_tokens: 6 },
  total_tokens: 52,
}

test('output_text parts concatenate into the message content', () => {
  const result = fromResponse(response({
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [
        { type: 'output_text', text: 'Hello ', annotations: [] },
        { type: 'output_text', text: 'world', annotations: [] },
      ],
    }],
  }))

  expect(result.object).toBe('chat.completion')
  expect(result.created).toBe(1700000000)
  expect(result.choices).toHaveLength(1)
  expect(result.choices[0].message.content).toBe('Hello world')
  expect(result.choices[0].finish_reason).toBe('stop')
})

test('a function_call item becomes a tool call keeping its call id', () => {
  const result = fromResponse(response({
    output: [{
      type: 'function_call', id: 'fc_1', call_id: 'call_1',
      name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed',
    }],
  }))

  const call = result.choices[0].message.tool_calls?.[0]
  expect(call?.id).toBe('call_1')
  expect(call?.function.name).toBe('get_weather')
  expect(result.choices[0].finish_reason).toBe('tool_calls')
})

test('reasoning summaries land on reasoning_content', () => {
  const result = fromResponse(response({
    output: [{
      type: 'reasoning', id: 'rs_1',
      summary: [
        { type: 'summary_text', text: 'Checking ' },
        { type: 'summary_text', text: 'the weather.' },
      ],
    }],
  }))

  const message = result.choices[0].message as { reasoning_content?: string }
  expect(message.reasoning_content).toBe('Checking the weather.')
})

test('raw reasoning text is used when no summary was produced', () => {
  const result = fromResponse(response({
    output: [{
      type: 'reasoning', id: 'rs_1', summary: [],
      content: [{ type: 'reasoning_text', text: 'step one' }],
    }],
  }))

  expect((result.choices[0].message as { reasoning_content?: string }).reasoning_content)
    .toBe('step one')
})

test('a refusal part lands on the message refusal', () => {
  const result = fromResponse(response({
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
    }],
  }))

  expect(result.choices[0].message.refusal).toBe('I cannot help with that.')
  expect(result.choices[0].message.content).toBeNull()
})

test('hosted tool items are ignored rather than breaking the translation', () => {
  const result = fromResponse(response({
    output: [
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      {
        type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      },
    ],
  }))

  expect(result.choices[0].message.content).toBe('done')
})

test('an incomplete response truncated by the token cap finishes as length', () => {
  const result = fromResponse(response({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'incomplete',
      content: [{ type: 'output_text', text: 'half', annotations: [] }],
    }],
  }))

  expect(result.choices[0].finish_reason).toBe('length')
})

test('an incomplete response stopped by a filter finishes as content_filter', () => {
  const result = fromResponse(response({
    status: 'incomplete',
    incomplete_details: { reason: 'content_filter' },
  }))

  expect(result.choices[0].finish_reason).toBe('content_filter')
})

test('tool calls win over an incomplete reason when deriving finish_reason', () => {
  const result = fromResponse(response({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
      type: 'function_call', id: 'fc_1', call_id: 'call_1',
      name: 'f', arguments: '{}', status: 'completed',
    }],
  }))

  expect(result.choices[0].finish_reason).toBe('tool_calls')
})

test('usage maps across, including reasoning and cached tokens', () => {
  const result = fromResponse(response({ usage }))

  expect(result.usage).toEqual({
    prompt_tokens: 40,
    completion_tokens: 12,
    total_tokens: 52,
    completion_tokens_details: { reasoning_tokens: 6 },
    prompt_tokens_details: { cached_tokens: 8 },
  })
})

test('an empty output produces one choice with null content', () => {
  const result = fromResponse(response())
  expect(result.choices[0].message.content).toBeNull()
  expect(result.choices[0].index).toBe(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/translate/chat-to-responses.test.ts`
Expected: FAIL — `fromResponse is not exported`.

- [ ] **Step 3: Implement the result translator**

Append to `src/lib/translate/chat-to-responses.ts`, and add `ChatCompletion` to the imports from `@/lib/adapters/types`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/lib/translate/chat-to-responses.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/translate/chat-to-responses.ts tests/lib/translate/chat-to-responses.test.ts
git commit -m "feat(translate): map a Responses result back to a ChatCompletion"
```

---

### Task 5: Translate the Responses event stream into Chat Completions chunks

The hardest piece. Chat Completions chunks are positional deltas on `choices[0].delta`; Responses events are semantic and indexed by `output_index`, which counts *all* output items — reasoning and messages included — while `tool_calls[].index` counts only tool calls.

Three things this task exists to get right, each with its own named test:

1. **`.done` events are ignored.** They restate what the deltas already delivered. Translating them is how every response ends up duplicated.
2. **`role: 'assistant'` is held, not emitted on `response.created`.** `startChatStream` pulls the first chunk eagerly, and that pull is simultaneously the failover boundary and the `ttftMs` measurement. Emitting at acceptance time would turn a clean failover into an SSE error event and make `ttftMs` mean something else.
3. **Tool indices are dense.** `output_index` is not.

`response.created` is still *read* — it carries `created_at` and `model` for the chunks — it just emits nothing.

**Files:**
- Modify: `src/lib/translate/chat-to-responses.ts`
- Create: `tests/fixtures/openai-responses-tool-call-stream.json`
- Test: `tests/lib/translate/chat-to-responses.test.ts` (append)

**Interfaces:**
- Consumes: `finishReason`, `toUsage` (Task 4).
- Produces: `fromResponseStream(events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>, req: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk>`

- [ ] **Step 1: Create the fixture**

`tests/fixtures/openai-responses-tool-call-stream.json` — a reasoning-then-tool-call stream, deliberately including the `.done` and `output_item.done` events that must be ignored:

```json
[
  {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","created_at":1700000000,"model":"gpt-5-mini","status":"in_progress","output":[]}},
  {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_1","status":"in_progress"}},
  {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}},
  {"type":"response.reasoning_summary_text.delta","sequence_number":3,"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"Checking "},
  {"type":"response.reasoning_summary_text.delta","sequence_number":4,"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"the weather."},
  {"type":"response.reasoning_summary_text.done","sequence_number":5,"item_id":"rs_1","output_index":0,"summary_index":0,"text":"Checking the weather."},
  {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"Checking the weather."}]}},
  {"type":"response.output_item.added","sequence_number":7,"output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather","arguments":"","status":"in_progress"}},
  {"type":"response.function_call_arguments.delta","sequence_number":8,"item_id":"fc_1","output_index":1,"delta":"{\"city\":"},
  {"type":"response.function_call_arguments.delta","sequence_number":9,"item_id":"fc_1","output_index":1,"delta":"\"Paris\"}"},
  {"type":"response.function_call_arguments.done","sequence_number":10,"item_id":"fc_1","output_index":1,"arguments":"{\"city\":\"Paris\"}"},
  {"type":"response.output_item.done","sequence_number":11,"output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"Paris\"}","status":"completed"}},
  {"type":"response.completed","sequence_number":12,"response":{"id":"resp_1","object":"response","created_at":1700000000,"model":"gpt-5-mini","status":"completed","incomplete_details":null,"output":[{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"Paris\"}","status":"completed"}],"usage":{"input_tokens":40,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"output_tokens":12,"output_tokens_details":{"reasoning_tokens":6},"total_tokens":52}}}
]
```

- [ ] **Step 2: Write the failing tests**

Extend the top-of-file imports — add `fromResponseStream` to the existing `@/lib/translate/chat-to-responses` import, and add these two lines beside the others, rather than importing mid-file:

```ts
import type { ChatCompletionChunk } from '@/lib/adapters/types'
import streamFixture from '../../fixtures/openai-responses-tool-call-stream.json'
```

Then append:

```ts
async function collectStream(
  events: unknown[],
  req: ChatCompletionRequest = request({ stream: true }),
): Promise<ChatCompletionChunk[]> {
  async function* source() {
    for (const event of events) yield event
  }
  const out: ChatCompletionChunk[] = []
  for await (const chunk of fromResponseStream(source() as never, req)) out.push(chunk)
  return out
}

test('the done events are ignored, so no content is duplicated', async () => {
  const chunks = await collectStream(streamFixture)

  const reasoning = chunks
    .map((c) => (c.choices[0]?.delta as { reasoning_content?: string })?.reasoning_content ?? '')
    .join('')
  expect(reasoning).toBe('Checking the weather.')

  const args = chunks
    .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
    .map((call) => call.function?.arguments ?? '')
    .join('')
  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
})

test('the assistant role appears exactly once, on the first emitted chunk', async () => {
  const chunks = await collectStream(streamFixture)

  const withRole = chunks.filter((c) => c.choices[0]?.delta?.role !== undefined)
  expect(withRole).toHaveLength(1)
  expect(chunks[0].choices[0].delta.role).toBe('assistant')
  // Held rather than emitted at response.created: the first chunk must carry
  // real content, because that pull is the failover boundary.
  expect(
    (chunks[0].choices[0].delta as { reasoning_content?: string }).reasoning_content,
  ).toBe('Checking ')
})

test('tool call indices are dense even though output_index is not', async () => {
  const chunks = await collectStream(streamFixture)
  const fragments = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])

  // The function call sits at output_index 1, behind a reasoning item.
  expect(fragments.every((fragment) => fragment.index === 0)).toBe(true)
})

test('the tool call id and name arrive on the opening fragment only', async () => {
  const chunks = await collectStream(streamFixture)
  const fragments = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])

  expect(fragments[0].id).toBe('call_1')
  expect(fragments[0].function?.name).toBe('get_weather')
  expect(fragments.slice(1).every((fragment) => fragment.id === undefined)).toBe(true)
})

test('two function calls get distinct dense indices', async () => {
  const chunks = await collectStream([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs', type: 'reasoning', summary: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'a', type: 'function_call', call_id: 'call_a', name: 'a', arguments: '' } },
    { type: 'response.output_item.added', output_index: 2, item: { id: 'b', type: 'function_call', call_id: 'call_b', name: 'b', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'b', delta: '{}' },
    { type: 'response.completed', response: { id: 'r', created_at: 1, model: 'm', status: 'completed', incomplete_details: null, output: [] } },
  ])

  const fragments = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
  expect(fragments.map((fragment) => fragment.index)).toEqual([0, 1, 1])
})

test('the finish reason precedes the usage chunk', async () => {
  const chunks = await collectStream(streamFixture)

  expect(chunks.at(-2)?.choices[0].finish_reason).toBe('tool_calls')
  expect(chunks.at(-1)?.usage?.total_tokens).toBe(52)
  expect(chunks.at(-1)?.choices).toEqual([])
})

test('the usage chunk is omitted when the client opted out', async () => {
  const chunks = await collectStream(
    streamFixture,
    request({ stream: true, stream_options: { include_usage: false } }),
  )

  expect(chunks.at(-1)?.usage).toBeUndefined()
  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('tool_calls')
})

test('chunks carry the model and creation time from response.created', async () => {
  const chunks = await collectStream(streamFixture)
  expect(chunks[0].model).toBe('gpt-5-mini')
  expect(chunks[0].created).toBe(1700000000)
})

test('output text deltas become content deltas', async () => {
  const chunks = await collectStream([
    { type: 'response.created', response: { id: 'r', created_at: 1, model: 'm', status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'Hello' },
    { type: 'response.output_text.done', output_index: 0, item_id: 'm1', text: 'Hello' },
    { type: 'response.completed', response: { id: 'r', created_at: 1, model: 'm', status: 'completed', incomplete_details: null, output: [] } },
  ])

  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')
  expect(text).toBe('Hello')
  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('stop')
})

test('an incomplete response finishes as length', async () => {
  const chunks = await collectStream([
    { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'half' },
    { type: 'response.incomplete', response: { id: 'r', created_at: 1, model: 'm', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } },
  ])

  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('length')
})

test('a failed response throws so the routing loop can classify it', async () => {
  await expect(
    collectStream([
      { type: 'response.failed', response: { id: 'r', created_at: 1, model: 'm', status: 'failed', error: { code: 'server_error', message: 'upstream exploded' }, output: [] } },
    ]),
  ).rejects.toThrow('upstream exploded')
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/lib/translate/chat-to-responses.test.ts`
Expected: FAIL — `fromResponseStream is not exported`.

- [ ] **Step 4: Implement the stream translator**

Append to `src/lib/translate/chat-to-responses.ts`, adding `ChatCompletionChunk` to the `@/lib/adapters/types` imports:

```ts
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
  let created = 0
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/lib/translate/chat-to-responses.test.ts`
Expected: PASS — 12 stream tests plus everything from Tasks 3 and 4.

- [ ] **Step 6: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/translate/chat-to-responses.ts tests/lib/translate/chat-to-responses.test.ts tests/fixtures/openai-responses-tool-call-stream.json
git commit -m "feat(translate): map the Responses event stream to Chat Completions chunks"
```

---

### Task 6: The Responses adapter, and the registry branch that picks it

The first task where a Responses provider can actually serve a request. The adapter holds no translation logic — it is the seam between an SDK client and the pure module.

**Files:**
- Create: `src/lib/adapters/openai/responses.ts`
- Modify: `src/lib/adapters/registry.ts`
- Test: `tests/lib/adapters/openai/responses-chat.test.ts` (new)
- Test: `tests/lib/adapters/openai/responses-stream.test.ts` (new)
- Test: `tests/lib/adapters/registry.test.ts` (append)

**Interfaces:**
- Consumes: `createOpenAIClient`, `listModels` (Task 2); `toResponsesRequest`, `fromResponse`, `fromResponseStream` (Tasks 3–5); `resolveApiFlavor` (Task 1).
- Produces: `createResponsesAdapter(runtime: ProviderRuntime, createClient?: OpenAIClientFactory): ProviderAdapter`

- [ ] **Step 1: Write the failing tests**

`tests/lib/adapters/openai/responses-chat.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ProviderRuntime } from '@/lib/adapters/types'

const runtime: ProviderRuntime = {
  id: 'p1',
  name: 'responses-provider',
  adapter: 'openai_compatible',
  baseUrl: 'https://api.example/v1',
  credentials: { apiKey: 'sk-test' },
  config: {},
  apiFlavor: 'responses',
}

const ctx = {
  upstreamModel: 'gpt-5-mini',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const upstream = {
  id: 'resp_1',
  object: 'response',
  created_at: 1700000000,
  model: 'gpt-5-mini',
  status: 'completed',
  incomplete_details: null,
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  usage: {
    input_tokens: 5,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 7,
  },
}

function fakeClient(result: unknown = upstream) {
  const create = vi.fn().mockResolvedValue(result)
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  return { create, factory }
}

const body = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }] }

test('calls the responses endpoint, not chat completions', async () => {
  const { create, factory } = fakeClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  await adapter.chat(body, ctx)

  expect(create).toHaveBeenCalledTimes(1)
  expect(create.mock.calls[0][0].model).toBe('gpt-5-mini')
  expect(create.mock.calls[0][0].store).toBe(false)
  expect(create.mock.calls[0][0].stream).toBe(false)
})

test('builds the client from credentials and base URL', async () => {
  const { factory } = fakeClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  await adapter.chat(body, ctx)

  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: 'sk-test', baseURL: 'https://api.example/v1' }),
  )
})

test('passes the abort signal to the SDK', async () => {
  const { create, factory } = fakeClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  await adapter.chat(body, ctx)
  expect(create.mock.calls[0][1]).toMatchObject({ signal: ctx.signal })
})

test('returns a Chat Completions shaped result', async () => {
  const { factory } = fakeClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  const result = await adapter.chat(body, ctx)

  expect(result.object).toBe('chat.completion')
  expect(result.choices[0].message.content).toBe('hi')
  expect(result.usage?.total_tokens).toBe(7)
})

test('the provider config reaches the translator', async () => {
  const { create, factory } = fakeClient()
  const adapter = createResponsesAdapter(
    { ...runtime, config: { requestReasoningSummary: true } },
    factory as never,
  )
  await adapter.chat(body, ctx)

  expect(create.mock.calls[0][0].reasoning).toEqual({ summary: 'auto' })
})

test('an upstream API error is normalised into a ProviderError', async () => {
  const create = vi.fn().mockRejectedValue(
    new OpenAI.APIError(429, { message: 'slow down', code: 'rate_limit_exceeded' }, 'slow down', undefined),
  )
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  const adapter = createResponsesAdapter(runtime, factory as never)

  await expect(adapter.chat(body, ctx)).rejects.toMatchObject({
    status: 429,
    retryable: true,
  })
})

test('throws when the credentials have no apiKey', () => {
  const { factory } = fakeClient()
  expect(() =>
    createResponsesAdapter({ ...runtime, credentials: {} }, factory as never),
  ).toThrow(/apiKey/i)
})
```

`tests/lib/adapters/openai/responses-stream.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type { ChatCompletionChunk, ProviderRuntime } from '@/lib/adapters/types'
import fixture from '../../../fixtures/openai-responses-tool-call-stream.json'

const runtime: ProviderRuntime = {
  id: 'p1', name: 'responses-provider', adapter: 'openai', baseUrl: null,
  credentials: { apiKey: 'sk-test' }, config: {}, apiFlavor: 'responses',
}

const ctx = {
  upstreamModel: 'gpt-5-mini',
  signal: new AbortController().signal,
  requestId: 'req_1',
}

const request = {
  model: 'fast',
  messages: [{ role: 'user' as const, content: 'weather?' }],
  stream: true,
}

function streamingClient(events: unknown[] = fixture) {
  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }))
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  return { create, factory }
}

async function collect(iterable: AsyncIterable<ChatCompletionChunk>) {
  const out: ChatCompletionChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('opens the upstream stream with stream: true', async () => {
  const { create, factory } = streamingClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  await collect(adapter.chatStream(request, ctx))

  expect(create.mock.calls[0][0].stream).toBe(true)
  // Responses always reports usage on completion, so stream_options has no
  // upstream equivalent and must never be sent.
  expect(create.mock.calls[0][0]).not.toHaveProperty('stream_options')
})

test('emits Chat Completions chunks that reassemble the tool call', async () => {
  const { factory } = streamingClient()
  const adapter = createResponsesAdapter(runtime, factory as never)
  const chunks = await collect(adapter.chatStream(request, ctx))

  const args = chunks
    .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
    .map((call) => call.function?.arguments ?? '')
    .join('')

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
  expect(chunks.at(-1)?.usage?.total_tokens).toBe(52)
})

test('an error before the first chunk propagates to the caller', async () => {
  const create = vi.fn().mockRejectedValue(new Error('upstream down'))
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  const adapter = createResponsesAdapter(runtime, factory as never)

  await expect(collect(adapter.chatStream(request, ctx))).rejects.toThrow('upstream down')
})

test('an error thrown mid-stream propagates after the earlier chunks', async () => {
  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      yield fixture[0]
      yield fixture[3]
      throw new Error('connection reset')
    },
  }))
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  const adapter = createResponsesAdapter(runtime, factory as never)

  const seen: ChatCompletionChunk[] = []
  await expect(async () => {
    for await (const chunk of adapter.chatStream(request, ctx)) seen.push(chunk)
  }).rejects.toThrow('connection reset')
  expect(seen).toHaveLength(1)
})
```

Append to `tests/lib/adapters/registry.test.ts`:

```ts
test('a responses-flavored provider gets an adapter that speaks responses', () => {
  const adapter = createAdapter(provider({ apiFlavor: 'responses' }))
  expect(typeof adapter.chat).toBe('function')
  expect(typeof adapter.chatStream).toBe('function')
  expect(typeof adapter.listModels).toBe('function')
})

test('flavor is honoured for openai_compatible providers too', () => {
  const adapter = createAdapter(provider({
    adapter: 'openai_compatible',
    baseUrl: 'https://api.example/v1',
    apiFlavor: 'responses',
  }))
  expect(typeof adapter.chat).toBe('function')
})

test('a responses-flavored openai_compatible provider still needs a base URL', () => {
  expect(() =>
    createAdapter(provider({
      adapter: 'openai_compatible', baseUrl: null, apiFlavor: 'responses',
    })),
  ).toThrow(/base URL/i)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/adapters/openai/responses-chat.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the adapter**

`src/lib/adapters/openai/responses.ts`:

```ts
import type OpenAI from 'openai'
import {
  fromResponse,
  fromResponseStream,
  toResponsesRequest,
} from '@/lib/translate/chat-to-responses'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ProviderAdapter,
  ProviderRuntime,
} from '../types'
import { createOpenAIClient, listModels, type OpenAIClientFactory } from './client'
import { toProviderError } from './errors'

/**
 * A provider that serves /v1/responses but not /v1/chat/completions. It holds
 * no translation logic of its own — that lives in the pure module, which is
 * what makes it testable without a client — and satisfies the same
 * ProviderAdapter contract as the Chat Completions adapter, so the routing loop
 * never learns that two protocols exist.
 */
export function createResponsesAdapter(
  runtime: ProviderRuntime,
  createClient?: OpenAIClientFactory,
): ProviderAdapter {
  const client = createOpenAIClient(runtime, createClient)

  return {
    async chat(req, ctx): Promise<ChatCompletion> {
      try {
        const result = await client.responses.create(
          {
            ...toResponsesRequest(req, ctx.upstreamModel, runtime.config),
            stream: false,
          },
          { signal: ctx.signal },
        )
        return fromResponse(result as OpenAI.Responses.Response)
      } catch (err) {
        throw toProviderError(err)
      }
    },

    async *chatStream(req, ctx): AsyncIterable<ChatCompletionChunk> {
      // Both the call that opens the stream and the iteration that drains it
      // can fail, and they fail differently — the first before the gateway has
      // committed a response, the second after. Both must arrive at the routing
      // loop already interpreted.
      let stream
      try {
        stream = await client.responses.create(
          {
            ...toResponsesRequest(req, ctx.upstreamModel, runtime.config),
            stream: true,
          },
          { signal: ctx.signal },
        )
      } catch (err) {
        throw toProviderError(err)
      }

      try {
        yield* fromResponseStream(
          stream as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
          req,
        )
      } catch (err) {
        throw toProviderError(err)
      }
    },

    listModels: (ctx) => listModels(client, ctx),
  }
}
```

- [ ] **Step 4: Wire the registry branch**

In `src/lib/adapters/registry.ts`, import `createResponsesAdapter` from `./openai/responses` and replace the two OpenAI-shaped cases:

```ts
    case 'openai':
      return adapterFor(runtime, provider)
    case 'openai_compatible':
      if (!runtime.baseUrl) {
        throw new Error(
          `Provider "${runtime.name}" is openai_compatible but has no base URL configured.`,
        )
      }
      return adapterFor(runtime, provider)
```

with a small helper above `createAdapter`:

```ts
function adapterFor(runtime: ProviderRuntime, provider: ProviderRow): ProviderAdapter {
  return resolveApiFlavor(provider) === 'responses'
    ? createResponsesAdapter(runtime)
    : createOpenAIAdapter(runtime)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/lib/adapters/`
Expected: PASS

- [ ] **Step 6: Run the whole suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/adapters/openai/responses.ts src/lib/adapters/registry.ts tests/lib/adapters/openai/responses-chat.test.ts tests/lib/adapters/openai/responses-stream.test.ts tests/lib/adapters/registry.test.ts
git commit -m "feat(adapters): serve Responses-flavored providers through the chat interface"
```

---

### Task 7: Report dropped parameters on the response and in the log

`droppedParams` is called from the handler rather than returned through the adapter, because threading it back would put translation-specific knowledge into the interface every future adapter implements. The handler has everything it needs: `execute` returns the winning candidate, and its provider row carries the flavor.

**Files:**
- Modify: `src/lib/gateway/chat-handler.ts`
- Modify: `src/lib/gateway/request-log.ts`
- Test: `tests/lib/gateway/request-log.test.ts` (append)
- Test: `tests/gateway/dropped-params.test.ts` (new)

**Interfaces:**
- Consumes: `droppedParams` (Task 3), `resolveApiFlavor` (Task 1), `TargetSpec.apiFlavor` (Task 1).
- Produces: `attemptHeaders(candidate, requestId, dropped?: string[])`; `RequestLogFields.droppedParams?: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/gateway/request-log.test.ts`:

```ts
test('dropped parameters appear on the log line', () => {
  const line = buildRequestLog({
    requestId: 'req_1', key: 'k', model: 'm', stream: false,
    status: 200, outcome: 'ok', latencyMs: 5, attempts: [],
    droppedParams: ['n', 'stop'],
  })

  expect(line.dropped_params).toEqual(['n', 'stop'])
})

test('an empty dropped list is left off the log line entirely', () => {
  const line = buildRequestLog({
    requestId: 'req_1', key: 'k', model: 'm', stream: false,
    status: 200, outcome: 'ok', latencyMs: 5, attempts: [], droppedParams: [],
  })

  expect(line).not.toHaveProperty('dropped_params')
})
```

Check that file's existing import and helper names and match them.

`tests/gateway/dropped-params.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { chatRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { resetDb } from '../helpers/db'

function completion(from: string) {
  return {
    id: 'chatcmpl-upstream', object: 'chat.completion', created: 1,
    model: `${from}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content: from }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

test('a responses provider reports the parameters it could not express', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'resp', apiFlavor: 'responses' }],
  })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], n: 3, stop: ['\n'] },
      apiKey,
    ),
    fakeAdapterByProvider({ resp: { chat: vi.fn().mockResolvedValue(completion('resp')) } }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-dropped-params')?.split(',').sort())
    .toEqual(['n', 'stop'])
})

test('a chat completions provider reports nothing, because it drops nothing', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'cc', apiFlavor: 'chat_completions' }],
  })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], n: 3 },
      apiKey,
    ),
    fakeAdapterByProvider({ cc: { chat: vi.fn().mockResolvedValue(completion('cc')) } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})

test('the header names the flavor of the target that actually served', async () => {
  // The first target is a Responses provider that fails; the request lands on a
  // Chat Completions provider, which drops nothing.
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'resp', priority: 0, apiFlavor: 'responses' },
      { name: 'cc', priority: 1, apiFlavor: 'chat_completions' },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], n: 3 },
      apiKey,
    ),
    fakeAdapterByProvider({
      resp: { chat: vi.fn().mockRejectedValue(apiError(503, 'down')) },
      cc: { chat: vi.fn().mockResolvedValue(completion('cc')) },
    }),
  )

  expect(res.headers.get('x-babellm-provider')).toBe('cc')
  expect(res.headers.get('x-babellm-dropped-params')).toBeNull()
})

test('a streaming response carries the header too', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'resp', apiFlavor: 'responses' }],
  })

  const working = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'resp-model',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest(
      { model: 'house-model', messages: [{ role: 'user', content: 'hi' }], stream: true, n: 3 },
      apiKey,
    ),
    fakeAdapterByProvider({ resp: { chatStream: working as never } }),
  )

  expect(res.headers.get('x-babellm-dropped-params')).toBe('n')
  await res.text()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/gateway/dropped-params.test.ts`
Expected: FAIL — the header is null.

- [ ] **Step 3: Add the log field**

In `src/lib/gateway/request-log.ts`, add to `RequestLogFields`:

```ts
  /**
   * Parameters the winning target's protocol could not express. Empty for a
   * Chat Completions target, which drops nothing.
   */
  droppedParams?: string[]
```

And to the object `buildRequestLog` returns, after `latency_ms`:

```ts
    ...(fields.droppedParams?.length ? { dropped_params: fields.droppedParams } : {}),
```

- [ ] **Step 4: Compute and attach it in the handler**

In `src/lib/gateway/chat-handler.ts`:

Extend `attemptHeaders`:

```ts
export function attemptHeaders(
  candidate: Candidate,
  requestId: string,
  dropped: string[] = [],
): HeadersInit {
  return {
    'x-request-id': requestId,
    'x-babellm-provider': candidate.provider.name,
    'x-babellm-upstream-model': candidate.upstreamModel,
    ...(dropped.length > 0 ? { 'x-babellm-dropped-params': dropped.join(',') } : {}),
  }
}
```

Add a helper above it:

```ts
/**
 * Which request parameters the winning target could not express. Computed here
 * rather than returned by the adapter: the alternative is a channel through
 * ProviderAdapter, which would put translation-specific knowledge into the
 * interface every future adapter implements.
 */
function droppedFor(candidate: Candidate, body: ChatCompletionRequest): string[] {
  return resolveApiFlavor(candidate.provider) === 'responses' ? droppedParams(body) : []
}
```

Import `resolveApiFlavor` from `@/lib/adapters/registry`, `droppedParams` from `@/lib/translate/chat-to-responses`, and the `ChatCompletionRequest` type from `@/lib/schemas/chat`.

Inside `handleChatCompletions`, declare the tracked value beside `keyName` / `modelName` / `stream`:

```ts
  let dropped: string[] = []
```

Add it to the `log` closure's `emitRequestLog` call:

```ts
      ...(dropped.length > 0 ? { droppedParams: dropped } : {}),
```

Then set it and use it on both paths. Streaming:

```ts
      const ttftMs = Date.now() - startedAt
      dropped = droppedFor(result.candidate, body)

      return sseResponse(
        result.value,
        identity,
        attemptHeaders(result.candidate, requestId, dropped),
        (outcome) => log(200, outcome, result.attempts, ttftMs),
      )
```

Non-streaming:

```ts
    dropped = droppedFor(result.candidate, body)

    log(200, 'ok', result.attempts)
    return Response.json(rewriteCompletion(result.value, identity), {
      headers: attemptHeaders(result.candidate, requestId, dropped),
    })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/gateway/dropped-params.test.ts tests/lib/gateway/request-log.test.ts`
Expected: PASS

- [ ] **Step 6: Run the whole suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/gateway/chat-handler.ts src/lib/gateway/request-log.ts tests/lib/gateway/request-log.test.ts tests/gateway/dropped-params.test.ts
git commit -m "feat(gateway): report parameters a Responses target could not express"
```

---

### Task 8: Make a misconfigured flavor say so

The predictable support question is "I added my provider and everything 404s." The Chat Completions adapter always passes a hint; `toProviderError` appends it only on a 404, where it is the likely explanation. A 404 is already fatal, so the request still fails fast with the provider named — the only thing missing is the instruction.

**Files:**
- Modify: `src/lib/adapters/openai/errors.ts`
- Modify: `src/lib/adapters/openai/index.ts`
- Test: `tests/lib/adapters/openai/errors.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `toProviderError(err: unknown, hint?: string): ProviderError`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/adapters/openai/errors.test.ts` (matching that file's existing import of `toProviderError` and its `OpenAI.APIError` construction style):

```ts
test('a 404 carries the flavor hint when one is supplied', () => {
  const error = toProviderError(
    new OpenAI.APIError(404, { message: 'Not Found' }, 'Not Found', undefined),
    'try the responses flavor',
  )

  expect(error.status).toBe(404)
  expect(error.message).toContain('Not Found')
  expect(error.message).toContain('try the responses flavor')
})

test('a non-404 is left alone even when a hint is supplied', () => {
  const error = toProviderError(
    new OpenAI.APIError(401, { message: 'Unauthorized' }, 'Unauthorized', undefined),
    'try the responses flavor',
  )

  expect(error.message).toBe('Unauthorized')
})

test('a 404 without a hint is unchanged', () => {
  const error = toProviderError(
    new OpenAI.APIError(404, { message: 'Not Found' }, 'Not Found', undefined),
  )

  expect(error.message).toBe('Not Found')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/adapters/openai/errors.test.ts`
Expected: FAIL — the hint is not appended.

- [ ] **Step 3: Implement the hint**

In `src/lib/adapters/openai/errors.ts`, change the signature and the message:

```ts
export function toProviderError(err: unknown, hint?: string): ProviderError {
  if (err instanceof ProviderError) return err

  if (err instanceof OpenAI.APIError) {
    const status = err.status
    const retryable =
      status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500
    return new ProviderError({
      status: status ?? 502,
      code: err.code ?? null,
      ...(err.type ? { type: err.type } : {}),
      // A 404 from an OpenAI-shaped endpoint usually means the endpoint itself
      // is absent rather than the model, which is the single most likely
      // configuration mistake this gateway produces. The caller supplies the
      // instruction; only the status decides whether it is relevant.
      message: status === 404 && hint ? `${err.message} ${hint}` : err.message,
      retryable,
    })
  }

  // ... rest unchanged
}
```

- [ ] **Step 4: Pass the hint from the Chat Completions adapter**

In `src/lib/adapters/openai/index.ts`, add above `createOpenAIAdapter`:

```ts
const FLAVOR_HINT =
  'If this provider only implements the Responses API, set its API flavor to "responses" on the Providers page.'
```

and change every `toProviderError(err)` call in that file — there are three, one in `chat` and two in `chatStream` — to `toProviderError(err, FLAVOR_HINT)`.

Leave `src/lib/adapters/openai/responses.ts` alone: a Responses provider that 404s is not explained by the flavor setting.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/lib/adapters/openai/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/adapters/openai/errors.ts src/lib/adapters/openai/index.ts tests/lib/adapters/openai/errors.test.ts
git commit -m "feat(adapters): point a 404 at the API flavor setting"
```

---

### Task 9: Choose and see the flavor in the dashboard

**A deviation from `AGENTS.md` worth stating up front:** `AGENTS.md` says to prefer shadcn components, and `src/components/ui/select.tsx` exists. The flavor field sits directly beside the adapter field in the same grid, and that field is a raw `<select>` because `FormDialog` submits through a server action and needs a natively named form control. Introducing a second, visually different select pattern in the same two-column grid would be worse than matching the neighbour. So: raw `<select>` with identical classes.

This was verified before execution: `src/components/ui/select.tsx` wraps base-ui's Select and forwards no `name` prop and renders no hidden input, so it cannot participate in a server-action form submission at all. The raw `<select>` is not a preference here — it is the only option that works. Do not substitute the shadcn `Select`, and do not refactor the adjacent adapter field.

**Files:**
- Modify: `src/lib/admin/providers.ts`
- Modify: `src/app/(admin)/providers/actions.ts`
- Modify: `src/app/(admin)/providers/provider-form.tsx`
- Modify: `src/app/(admin)/providers/edit-provider-form.tsx`
- Modify: `src/app/(admin)/providers/page.tsx`
- Test: `tests/lib/admin/providers.test.ts` (append)

**Interfaces:**
- Consumes: `apiFlavors`, `ApiFlavor` (Task 1).
- Produces: `ProviderInput.apiFlavor?: ApiFlavor`, `ProviderListItem.apiFlavor: ApiFlavor`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/admin/providers.test.ts`, matching that file's existing setup and imports:

```ts
test('a provider is created with the chat_completions flavor by default', async () => {
  const row = await createProvider({
    name: 'plain', adapter: 'openai', credentials: { apiKey: 'sk-a' },
  })
  expect(row.apiFlavor).toBe('chat_completions')
})

test('a provider can be created with the responses flavor', async () => {
  const row = await createProvider({
    name: 'resp', adapter: 'openai', credentials: { apiKey: 'sk-a' },
    apiFlavor: 'responses',
  })
  expect(row.apiFlavor).toBe('responses')
})

test('updating a provider can change its flavor', async () => {
  const created = await createProvider({
    name: 'switch', adapter: 'openai', credentials: { apiKey: 'sk-a' },
  })
  const updated = await updateProvider(created.id, { apiFlavor: 'responses' })
  expect(updated.apiFlavor).toBe('responses')
})

test('an update that omits the flavor keeps the stored one', async () => {
  const created = await createProvider({
    name: 'keep', adapter: 'openai', credentials: { apiKey: 'sk-a' },
    apiFlavor: 'responses',
  })
  const updated = await updateProvider(created.id, { name: 'keep-renamed' })
  expect(updated.apiFlavor).toBe('responses')
})

test('listProviders reports each provider flavor', async () => {
  await createProvider({
    name: 'resp', adapter: 'openai', credentials: { apiKey: 'sk-a' },
    apiFlavor: 'responses',
  })
  const [item] = await listProviders()
  expect(item.apiFlavor).toBe('responses')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/lib/admin/providers.test.ts`
Expected: FAIL — `apiFlavor` is not a known property.

- [ ] **Step 3: Thread the field through the admin layer**

In `src/lib/admin/providers.ts`:

- Add `apiFlavor?: ApiFlavor` to `ProviderInput` and `apiFlavor: ApiFlavor` to `ProviderListItem`, importing the type from `@/lib/adapters/types`.
- In `listProviders`'s map, add `apiFlavor: row.apiFlavor,`.
- In `createProvider`'s insert values, add `apiFlavor: input.apiFlavor ?? 'chat_completions',`.
- In `updateProvider`'s update set, add `apiFlavor: input.apiFlavor ?? existing.apiFlavor,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/lib/admin/providers.test.ts`
Expected: PASS

- [ ] **Step 5: Parse the field in the server actions**

In `src/app/(admin)/providers/actions.ts`, add a parser beside `credentialsFrom`:

```ts
/**
 * The flavor field is only rendered for OpenAI-shaped adapters, so an absent
 * value means "not applicable" rather than "cleared" — createProvider defaults
 * it and updateProvider keeps whatever is stored.
 */
function apiFlavorFrom(formData: FormData): ApiFlavor | undefined {
  const value = formData.get('apiFlavor')
  if (typeof value !== 'string') return undefined
  return (apiFlavors as readonly string[]).includes(value)
    ? (value as ApiFlavor)
    : undefined
}
```

Import `apiFlavors` and `ApiFlavor` from `@/lib/adapters/types`.

In `createProviderAction`, add to the `createProvider` call:

```ts
      apiFlavor: apiFlavorFrom(formData),
```

In `updateProviderAction`, add the same line to the `updateProvider` call.

- [ ] **Step 6: Add the field to the create form**

In `src/app/(admin)/providers/provider-form.tsx`, after the adapter field's `</div>` and before `<RegistryNamespaceField …>`:

```tsx
        {adapter === 'openai' || adapter === 'openai_compatible' ? (
          <div className="space-y-2">
            <Label htmlFor="apiFlavor">API flavor</Label>
            <select
              id="apiFlavor"
              name="apiFlavor"
              defaultValue="chat_completions"
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
            >
              <option value="chat_completions">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Choose Responses if this endpoint returns 404 on
              {' '}<code>/v1/chat/completions</code>.
            </p>
          </div>
        ) : null}
```

- [ ] **Step 7: Add the field to the edit form**

In `src/app/(admin)/providers/edit-provider-form.tsx`, inside the same `grid` as the name and base URL fields, after the `baseUrl` block:

```tsx
        {provider.adapter === 'openai' || provider.adapter === 'openai_compatible' ? (
          <div className="space-y-2">
            <Label htmlFor={`apiFlavor-${provider.id}`}>API flavor</Label>
            <select
              id={`apiFlavor-${provider.id}`}
              name="apiFlavor"
              defaultValue={provider.apiFlavor}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
            >
              <option value="chat_completions">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </div>
        ) : null}
```

Unlike `adapter`, the flavor is editable, so it is a real control rather than a hidden input.

- [ ] **Step 8: Show the badge on the list**

In `src/app/(admin)/providers/page.tsx`, replace the adapter cell:

```tsx
                <TableCell className="text-muted-foreground">
                  {provider.adapter}
                  {provider.apiFlavor === 'responses' ? (
                    <Badge variant="secondary" className="ml-2">responses</Badge>
                  ) : null}
                </TableCell>
```

`Badge` is already imported in that file.

- [ ] **Step 9: Verify in the running app**

Run: `pnpm dev`

Check, at `http://localhost:3000/providers`:
1. **Add provider** shows an *API flavor* select for `openai` and `openai_compatible`, and hides it for `gemini` and `bedrock`.
2. Creating a provider with *Responses* selected puts a `responses` badge on its row.
3. Editing that provider shows *Responses* preselected, and switching it to *Chat Completions* and saving removes the badge.
4. Editing a `bedrock` provider still saves without error, despite having no flavor control.

- [ ] **Step 10: Lint and run the whole suite**

Run: `pnpm lint && pnpm test`
Expected: clean, PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/admin/providers.ts src/app/\(admin\)/providers tests/lib/admin/providers.test.ts
git commit -m "feat(admin): choose and display a provider's API flavor"
```

Stage only those paths — `src/app/(admin)/models/` holds unrelated uncommitted work.

---

### Task 10: Prove the seam holds end to end

Two tests carry this task. The mixed failover case is the one that proves the design: a Responses provider and a Chat Completions provider in one chain, producing one coherent response, with the routing loop unaware that two protocols were involved. The contract test proves the real `openai` SDK is satisfied by translated output.

Both build a *real* `createResponsesAdapter` over a fake SDK client and hand it to `fakeAdapterByProvider`, so the translation runs for real while the chain stays deterministic.

**Files:**
- Test: `tests/gateway/mixed-flavor.test.ts` (new)
- Test: `tests/contract/openai-client.test.ts` (append)

**Interfaces:**
- Consumes: `createResponsesAdapter` (Task 6), `seedTargets` / `fakeAdapterByProvider` (Task 1), the fixture (Task 5).
- Produces: nothing.

- [ ] **Step 1: Write the tests**

`tests/gateway/mixed-flavor.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { handleChatCompletions } from '@/lib/gateway/chat-handler'
import { createResponsesAdapter } from '@/lib/adapters/openai/responses'
import type {
  ChatCompletionChunk, ProviderAdapter, ProviderRuntime,
} from '@/lib/adapters/types'
import { chatRequest, fakeAdapterByProvider, seedTargets } from '../helpers/gateway'
import { parseSseChunks, sseTerminated } from '../helpers/sse'
import { resetDb } from '../helpers/db'
import fixture from '../fixtures/openai-responses-tool-call-stream.json'

const body = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] }

function runtime(name: string): ProviderRuntime {
  return {
    id: name, name, adapter: 'openai', baseUrl: null,
    credentials: { apiKey: 'sk-test' }, config: {}, apiFlavor: 'responses',
  }
}

/** A real Responses adapter over a fake SDK client, so translation runs. */
function responsesAdapter(name: string, create: unknown): ProviderAdapter {
  const factory = vi.fn().mockReturnValue({ responses: { create } })
  return createResponsesAdapter(runtime(name), factory as never)
}

function responseResult(text: string) {
  return {
    id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-5-mini',
    status: 'completed', incomplete_details: null,
    output: [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: {
      input_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2,
    },
  }
}

function completion(from: string) {
  return {
    id: 'chatcmpl-upstream', object: 'chat.completion', created: 1,
    model: `${from}-model`,
    choices: [{ index: 0, message: { role: 'assistant', content: from }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function apiError(status: number, message = 'boom') {
  return new OpenAI.APIError(status, { message, code: 'x' }, message, undefined)
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  await resetDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

test('a responses provider serves a plain chat completions request', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'resp', apiFlavor: 'responses' }],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      resp: responsesAdapter('resp', vi.fn().mockResolvedValue(responseResult('from responses'))),
    }),
  )

  expect(res.status).toBe(200)
  const payload = await res.json()
  expect(payload.object).toBe('chat.completion')
  expect(payload.model).toBe('house-model')
  expect(payload.choices[0].message.content).toBe('from responses')
  expect(payload.usage.total_tokens).toBe(2)
})

test('a failing responses target fails over onto a chat completions target', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'resp', priority: 0, apiFlavor: 'responses' },
      { name: 'cc', priority: 1, apiFlavor: 'chat_completions' },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      resp: responsesAdapter('resp', vi.fn().mockRejectedValue(apiError(503, 'down'))),
      cc: { chat: vi.fn().mockResolvedValue(completion('cc')) },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('cc')
  expect((await res.json()).choices[0].message.content).toBe('cc')
})

test('a failing chat completions target fails over onto a responses target', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'cc', priority: 0, apiFlavor: 'chat_completions' },
      { name: 'resp', priority: 1, apiFlavor: 'responses' },
    ],
  })

  const res = await handleChatCompletions(
    chatRequest(body, apiKey),
    fakeAdapterByProvider({
      cc: { chat: vi.fn().mockRejectedValue(apiError(429, 'slow down')) },
      resp: responsesAdapter('resp', vi.fn().mockResolvedValue(responseResult('rescued'))),
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('resp')
  expect((await res.json()).choices[0].message.content).toBe('rescued')
})

test('a responses provider streams through the SSE layer', async () => {
  const { apiKey } = await seedTargets({
    targets: [{ name: 'resp', apiFlavor: 'responses' }],
  })

  const create = vi.fn().mockImplementation(async () => ({
    async *[Symbol.asyncIterator]() {
      for (const event of fixture) yield event
    },
  }))

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterByProvider({ resp: responsesAdapter('resp', create) }),
  )

  expect(res.status).toBe(200)
  const text = await res.text()
  expect(sseTerminated(text)).toBe(true)

  const chunks = parseSseChunks(text) as ChatCompletionChunk[]
  const args = chunks
    .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
    .map((call) => call.function?.arguments ?? '')
    .join('')

  expect(JSON.parse(args)).toEqual({ city: 'Paris' })
  // Identity rewriting still applies: every chunk claims the virtual model.
  expect(chunks.every((c) => c.model === 'house-model')).toBe(true)
})

test('a responses stream that dies before its first chunk still fails over', async () => {
  const { apiKey } = await seedTargets({
    targets: [
      { name: 'resp', priority: 0, apiFlavor: 'responses' },
      { name: 'cc', priority: 1, apiFlavor: 'chat_completions' },
    ],
  })

  const working = async function* () {
    yield {
      id: 'up', object: 'chat.completion.chunk', created: 1, model: 'cc-model',
      choices: [{ index: 0, delta: { content: 'from cc' }, finish_reason: null }],
    }
  }

  const res = await handleChatCompletions(
    chatRequest({ ...body, stream: true }, apiKey),
    fakeAdapterByProvider({
      resp: responsesAdapter('resp', vi.fn().mockRejectedValue(apiError(503, 'down'))),
      cc: { chatStream: working as never },
    }),
  )

  expect(res.status).toBe(200)
  expect(res.headers.get('x-babellm-provider')).toBe('cc')
  expect(sseTerminated(await res.text())).toBe(true)
})
```

Append to `tests/contract/openai-client.test.ts`:

```ts
test('the SDK completes a tool call served by a Responses provider', async () => {
  const { apiKey } = await seedGateway({ apiFlavor: 'responses' })

  const create = vi.fn().mockResolvedValue({
    id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-5-mini',
    status: 'completed', incomplete_details: null,
    output: [{
      type: 'function_call', id: 'fc_1', call_id: 'call_1',
      name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed',
    }],
    usage: {
      input_tokens: 40, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 52,
    },
  })

  const client = gatewayClient(apiKey, createResponsesAdapter(
    {
      id: 'p', name: 'resp', adapter: 'openai', baseUrl: null,
      credentials: { apiKey: 'sk-test' }, config: {}, apiFlavor: 'responses',
    },
    vi.fn().mockReturnValue({ responses: { create } }) as never,
  ))

  const result = await client.chat.completions.create({
    model: 'house-model',
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
  })

  expect(result.model).toBe('house-model')
  const call = result.choices[0].message.tool_calls?.[0]
  if (call?.type !== 'function') throw new Error('expected a function tool call')
  expect(call.id).toBe('call_1')
  expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Paris' })
  expect(result.usage?.total_tokens).toBe(52)

  // The tool definition reached the upstream in Responses shape.
  expect(create.mock.calls[0][0].tools).toEqual([
    expect.objectContaining({ type: 'function', name: 'get_weather' }),
  ])
})
```

Add `import { createResponsesAdapter } from '@/lib/adapters/openai/responses'` to that file.

- [ ] **Step 2: Run the tests**

Run: `pnpm test tests/gateway/mixed-flavor.test.ts tests/contract/openai-client.test.ts`
Expected: PASS. These exercise code that already exists, so they should pass on the first run — if one fails, the bug is in Tasks 3–6 and belongs there, not patched here.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/gateway/mixed-flavor.test.ts tests/contract/openai-client.test.ts
git commit -m "test(gateway): cover mixed-flavor chains end to end"
```

---

### Task 11: Documentation

The `n`/`stop` caveat is the reason this task is not optional. It is the one place the feature returns a wrong answer that looks right, and it is undiscoverable by anyone who has not been told.

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-13-responses-api-flavor-design.md` (§4.1 only)

- [ ] **Step 1: Document the flavor in the README**

Add a subsection under **Routing**, after *Direct addressing*:

```markdown
### API flavor

Some OpenAI-compatible providers serve `/v1/responses` but not
`/v1/chat/completions`. Each `openai` or `openai_compatible` provider therefore
carries an **API flavor** — `Chat Completions` (the default) or `Responses` —
set on the Providers page. The gateway's own endpoint does not change: clients
always call `/v1/chat/completions`, and a Responses-flavored provider is
translated in both directions. A single virtual model can mix the two, and
failover crosses between them freely.

Two things to know before pointing production traffic at a Responses provider:

- **`n` and `stop` are silently ineffective.** The Responses API cannot express
  them, and the gateway drops unmappable parameters rather than rejecting
  requests that would otherwise work. Asking for `n: 3` returns one choice, and
  `stop` sequences do not apply. Every dropped parameter is named in the
  `x-babellm-dropped-params` response header and in the request log line —
  `logit_bias`, `logprobs`, `top_logprobs`, `frequency_penalty`,
  `presence_penalty` and `seed` are dropped the same way, but those only affect
  sampling rather than the shape of the answer.
- **Reasoning travels one way.** Reasoning summaries are surfaced as
  `message.reasoning_content` (and `delta.reasoning_content` when streaming) —
  a de-facto convention rather than part of the OpenAI API — but are never fed
  back upstream. Requests are stateless: `store` is always `false` and
  `previous_response_id` is never sent. On models that expect their own
  reasoning item before a function call, long tool loops may degrade.

Summaries are requested only when the client sends `reasoning_effort`, because
asking a non-reasoning model for them is an error. To request them regardless,
set `requestReasoningSummary: true` in the provider's config.

A provider on the wrong flavor fails fast: `/v1/chat/completions` returns `404`
from the upstream, and the error names the setting.
```

- [ ] **Step 2: Correct the "Not yet implemented" section**

That section currently says Phases 1 and 2 cover "the `openai` and `openai_compatible` adapters". Extend that clause to note both flavors, and add to the list:

```markdown
- **No `/v1/responses` endpoint.** Responses-flavored *providers* are supported;
  a Responses-shaped *client* is not. Everything enters through
  `/v1/chat/completions`.
```

- [ ] **Step 3: Correct the flavor spec's claim about the SQLite spec**

This was checked before execution and the original instruction was wrong. `docs/superpowers/specs/2026-08-13-sqlite-support-design.md` does **not** enumerate individual enums — it carries one general rule (`pgEnum(...)` → `text({ enum: [...] })`, in its type-mapping table) and never names `adapter`, `routing_policy` or any other enum. That rule already covers `api_flavor`, so **there is nothing to add to it. Do not edit the SQLite spec.**

Instead, correct the claim in this feature's own spec, `docs/superpowers/specs/2026-08-13-responses-api-flavor-design.md` §4.1, which asserts an inventory that does not exist. Replace its second paragraph:

```markdown
This is the fifth `pgEnum` in the schema. The SQLite design
(`2026-08-13-sqlite-support-design.md`) maps every `pgEnum` to
`text({ enum: [...] })` under one general rule rather than listing enums
individually, so `api_flavor` needs no entry there and that spec is
unaffected by this phase.
```

- [ ] **Step 4: Verify the README renders and its claims are true**

Re-read the new section against the implementation. In particular confirm that the dropped-parameter list matches `UNMAPPABLE` in `src/lib/translate/chat-to-responses.ts` exactly, and that the inert-default behaviour is not contradicted.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-13-responses-api-flavor-design.md
git commit -m "docs: document provider API flavor and its parameter caveats"
```

---

## Verification

After Task 11, confirm the whole feature from a clean state.

- [ ] **Full suite:** `pnpm test` — PASS, with no test skipped.
- [ ] **Lint:** `pnpm lint` — clean.
- [ ] **Build:** `pnpm build` — succeeds.
- [ ] **Migration from scratch:** drop and recreate the dev database, then `pnpm db:migrate`. Confirm `providers.api_flavor` exists with the `chat_completions` default and that no earlier migration was edited.
- [ ] **Manual smoke:** with `pnpm dev`, create an `openai_compatible` provider on the Responses flavor pointing at a real Responses endpoint, add a route target, and send both a streaming and a non-streaming request through `/v1/chat/completions`. Confirm the response headers name the provider, and that a request carrying `n: 3` comes back with `x-babellm-dropped-params: n`.
- [ ] **Interface check:** `git diff master -- src/lib/adapters/types.ts` shows no change to `ProviderAdapter`. If `respond` or `respondStream` appears, it does not belong in this phase.
- [ ] **Scope check:** `src/lib/translate/` contains exactly one file, and `src/app/v1/` contains only `chat/completions/route.ts`.
