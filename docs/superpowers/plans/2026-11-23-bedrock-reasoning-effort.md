# Bedrock `reasoning_effort` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate `reasoning_effort` into Bedrock Converse `additionalModelRequestFields` for Claude and OpenAI models, detected by model-ID prefix.

**Architecture:** A new pure module `src/lib/translate/bedrock-reasoning.ts` decides the reasoning fields (and any `maxTokens` override) from the request, upstream model and provider config. `toConverseRequest` merges its output with the existing cache field; `droppedParams` stops reporting `reasoning_effort` when it was translated. The adapter and `droppedForChat` pass the extra arguments through.

**Tech Stack:** TypeScript, `@aws-sdk/client-bedrock-runtime` types, vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-bedrock-reasoning-effort-design.md`

## Global Constraints

- Tests run with `pnpm test` against the disposable Postgres on **5434** (`.env.test` from `.env.test.example`). Never 5432. These tasks are pure unit tests, but the full suite touches the DB.
- Claude adaptive shape: `{ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } }`.
- Claude legacy shape: `{ thinking: { type: 'enabled', budget_tokens } }`; budgets `low` 2048, `medium` 8192, `high` 16384, any other effort → 16384; default max `budget + 4096`; clamp to `maxTokens - 1`; below 1024 → no thinking, reported dropped.
- OpenAI shape: `{ reasoning: { effort, summary: 'auto' } }`, effort forwarded verbatim.
- `none` → no reasoning fields. Claude-only alias `minimal` → `low`.
- Unsupported families (anything not `anthropic.claude-*` / `openai.*`, and Claude 3.0/3.5) → request unchanged, `reasoning_effort` stays dropped.
- `cache_control` and reasoning fields must coexist in `additionalModelRequestFields`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Region-prefixed and ARN IDs (`global.openai.gpt-6.2-sol`, `arn:…:inference-profile/us.anthropic.claude-sonnet-4-5-…`) must detect the right family — Task 1.
2. Legacy Claude with a small client `max_tokens` (e.g. 1500) must not send a budget ≥ max — Task 1.
3. Automatic-cache Claude model + effort must keep `cache_control` — Task 2.
4. `requestReasoningSummary: true` with `reasoning_effort: 'none'` sends nothing — Task 1.
5. `reasoning_effort` on a Meta/Mistral model is still reported dropped and the request is byte-identical to today — Task 2.

---

### Task 1: Reasoning-field resolver

**Files:**
- Create: `src/lib/translate/bedrock-reasoning.ts`
- Test: `tests/lib/translate/bedrock-reasoning.test.ts`

**Interfaces:**
- Consumes: `ChatCompletionRequest` (`@/lib/schemas/chat`), `ProviderConfig` (`@/lib/adapters/types`).
- Produces:
  ```ts
  export interface BedrockReasoning {
    /** Merged into additionalModelRequestFields; absent when nothing to send. */
    fields?: Record<string, unknown>
    /** Set only when the legacy budget path needs a max the client didn't give. */
    maxTokens?: number
    /** True when a non-empty, non-'none' reasoning_effort was expressed. */
    translated: boolean
  }
  export function bedrockReasoning(req: ChatCompletionRequest, upstreamModel: string, config?: ProviderConfig): BedrockReasoning
  ```

- [ ] **Step 1: Write the failing tests** (`const r = (extra, model, config?) => bedrockReasoning({ ...base, ...extra }, model, config)`)
  - `claude adaptive`: `{reasoning_effort:'high'}`, `anthropic.claude-sonnet-5-5` → `fields` `{ thinking:{type:'adaptive',display:'summarized'}, output_config:{effort:'high'} }`, `translated: true`, no `maxTokens`.
  - `claude new model works unlisted`: `us.anthropic.claude-opus-9-0-v1:0` → adaptive shape.
  - `minimal aliases to low for claude`: `output_config.effort === 'low'`.
  - `claude legacy budget`: `anthropic.claude-sonnet-4-5-20250929-v1:0`, `medium` → `fields` `{ thinking:{type:'enabled',budget_tokens:8192} }`, `maxTokens: 12288`.
  - `legacy ids`: each of `anthropic.claude-3-7-sonnet-20250219-v1:0`, `anthropic.claude-sonnet-4-20250514-v1:0`, `anthropic.claude-opus-4-20250514-v1:0`, `anthropic.claude-opus-4-1-20250805-v1:0`, `anthropic.claude-haiku-4-5-20251001-v1:0`, `anthropic.claude-opus-4-5-20251101-v1:0` → `thinking.type === 'enabled'`; `anthropic.claude-opus-4-6-v1` and `anthropic.claude-sonnet-4-6` → `'adaptive'`.
  - `legacy xhigh uses high budget`: budget 16384.
  - `legacy clamps to client max`: `max_tokens: 5000`, `high` → budget 4999, no `maxTokens`.
  - `legacy too small to think`: `max_tokens: 1000` → `fields` undefined, `translated: false`.
  - `claude 3.5 unsupported`: `anthropic.claude-3-5-sonnet-20241022-v2:0` → `{ translated: false }`.
  - `openai`: `global.openai.gpt-6.2-sol`, `xhigh` → `fields` `{ reasoning:{effort:'xhigh',summary:'auto'} }`; `minimal` stays `'minimal'`.
  - `ARN`: `arn:aws:bedrock:us-east-1:1:inference-profile/us.openai.gpt-oss-120b-1:0` → openai shape.
  - `none sends nothing`: both families → `{ translated: false }` with no `fields`, also when `config.requestReasoningSummary` is true.
  - `opt-in without effort`: `requestReasoningSummary:true` → Claude new `{ thinking:{type:'adaptive',display:'summarized'} }`; Claude legacy medium budget; OpenAI `{ reasoning:{summary:'auto'} }`; all with `translated: false`.
  - `unsupported family`: `meta.llama4-maverick-17b-instruct-v1:0` and an application-inference-profile ARN `…:application-inference-profile/abc123` → `{ translated: false }`.

- [ ] **Step 2: Run** `pnpm vitest run tests/lib/translate/bedrock-reasoning.test.ts` — expected FAIL (module not found).

- [ ] **Step 3: Implement `bedrockReasoning`.** Model ID = text after last `/`, then strip a leading `[a-z]+\.` geo prefix only if what follows starts with `anthropic.` or `openai.`. Legacy Claude = regex on the ID matching `claude-3-7-`, `claude-(sonnet|opus)-4-\d{8}`, `claude-opus-4-1-`, `claude-(sonnet|haiku|opus)-4-5-`; unsupported Claude = `claude-3-(?!7)` / `claude-3-5-` / `claude-instant`. Reuse the alias idea from `chat-to-anthropic.ts` (`minimal`→`low`) locally; do not import from it.

- [ ] **Step 4: Run** the test file — expected PASS.

- [ ] **Step 5: Commit** `feat(bedrock): resolve reasoning fields per model family`.

### Task 2: Wire into Converse request, dropped params, adapter

**Files:**
- Modify: `src/lib/translate/chat-to-bedrock.ts` (`toConverseRequest` ~112-201, `droppedParams` ~350-396)
- Modify: `src/lib/adapters/bedrock/index.ts` (both `toConverseRequest` calls)
- Modify: `src/lib/gateway/protocols/dropped.ts` (`bedrockDropped(req)` → `bedrockDropped(req, candidate.upstreamModel)`)
- Test: `tests/lib/translate/chat-to-bedrock-request.test.ts`; update existing `droppedParams(req)` calls to pass a model.

**Interfaces:**
- Consumes: `bedrockReasoning` from Task 1.
- Produces:
  - `toConverseRequest(req: ChatCompletionRequest, upstreamModel: string, config?: ProviderConfig): ConverseCommandInput`
  - `droppedParams(req: ChatCompletionRequest, upstreamModel: string): string[]`

- [ ] **Step 1: Write the failing tests** in `chat-to-bedrock-request.test.ts`:
  - `reasoning effort with automatic cache`: `anthropic.claude-sonnet-5-5`, `high` → `additionalModelRequestFields` equals `{ cache_control:{type:'ephemeral'}, thinking:{type:'adaptive',display:'summarized'}, output_config:{effort:'high'} }`.
  - `legacy budget sets maxTokens`: `anthropic.claude-sonnet-4-5-20250929-v1:0`, `low`, no max → `inferenceConfig.maxTokens === 6144`.
  - `openai effort`: `global.openai.gpt-6.1-terra`, `low` → `additionalModelRequestFields` `{ reasoning:{effort:'low',summary:'auto'} }`.
  - `provider opt-in`: third arg `{ requestReasoningSummary:true }` on an OpenAI model → `{ reasoning:{summary:'auto'} }`.
  - `unsupported family unchanged`: `meta.llama4-maverick-17b-instruct-v1:0` with `reasoning_effort:'high'` → result `toEqual` the same call without `reasoning_effort`.
  - `droppedParams`: `reasoning_effort` absent for Claude/OpenAI models, present for the Meta model, present for legacy Claude with `max_tokens: 1000`.

- [ ] **Step 2: Run** `pnpm vitest run tests/lib/translate/chat-to-bedrock-request.test.ts` — expected FAIL on the new tests.

- [ ] **Step 3: Implement.** In `toConverseRequest`, call `bedrockReasoning(req, upstreamModel, config)`; `inferenceConfig.maxTokens` = client max ?? `reasoning.maxTokens`; `additionalModelRequestFields` = `{ ...cacheFields, ...reasoning.fields }`, omitted when empty. In `droppedParams`, skip `reasoning_effort` when `bedrockReasoning(req, upstreamModel).translated`. Adapter passes `runtime.config`; `dropped.ts` passes `candidate.upstreamModel`.

- [ ] **Step 4: Run** `pnpm typecheck` (or `pnpm tsc --noEmit` if no script) and `pnpm vitest run tests/lib/translate tests/lib/adapters tests/lib/gateway` — expected PASS, no type errors.

- [ ] **Step 5: Run full suite** `pnpm test` (5434 test DB up via `pnpm test:db:up` if not running; do not run `test:db:down`) — expected all pass.

- [ ] **Step 6: Commit** `feat(bedrock): send reasoning_effort to Claude and OpenAI models`.
