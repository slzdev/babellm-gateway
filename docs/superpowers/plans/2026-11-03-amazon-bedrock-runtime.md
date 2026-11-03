# Amazon Bedrock Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Serve native Bedrock chat and streaming with automatic Catalog discovery.

**Architecture:** Pure OpenAI-to-Converse translation, thin injectable AWS SDK clients, provider error classification, and existing protocol wrappers/routing. Control-plane discovery lists foundation models and inference profiles; authentication uses stored static credentials or the AWS default credential chain.

**Tech Stack:** Next.js 16.3, TypeScript, AWS SDK v3, Zod, Vitest, Postgres.

**Spec:** docs/superpowers/specs/2026-11-03-amazon-bedrock-runtime-design.md

## Global Constraints

- Work in /Users/pss/Code/oss/babellm-gateway on codex/amazon-bedrock-runtime; this is the user's selected original workspace. Use explicit workdir for every command. Writes require escalation because the app currently points at an unused worktree.
- Never test against port 5432. Use .env.test copied from .env.test.example with database babellm_test_bedrock on 5434. Never stop shared test containers.
- Read the installed Next.js guide before changing Next code; reuse shadcn primitives in UI.
- No schema migration, external image fetches, live AWS credentials, or SDK retry loop. Every SDK call receives caller cancellation.
- Unsupported content/parameters are reported through the existing dropped-parameter contract. Embeddings, audio transcription and Decisions are unsupported for this adapter.
- Tests and checks run with original workspace dependencies and environment. Do not spawn further subagents. Each task implementer owns its full test cycle and commit; controller supplies independent review.

## Review Focus

- Stream usage follows messageStop; final cost must include it, and truncation must fail rather than look successful (Task 1).
- Tool blocks may be interspersed with text/reasoning and require contiguous OpenAI indices (Task 1).
- A Bedrock target carrying responses flavor must still use translation and unsupported-operation routing (Task 2).
- Failure on a later discovery page must not mark valid catalog entries missing (Task 2).
- Switching authentication modes must not retain stale keys or silently discard newly typed keys (Task 3).

### Task 1: Pure Converse translation

**Files:** Create src/lib/translate/chat-to-bedrock.ts and focused tests/lib/translate/chat-to-bedrock-*.test.ts. Modify package.json and pnpm-lock.yaml for @aws-sdk/client-bedrock-runtime and @aws-sdk/client-bedrock (controller installs these before dispatch).

**Interfaces:** Export toConverseRequest(req: ChatCompletionRequest, upstreamModel: string): ConverseCommandInput; fromConverse(result: ConverseCommandOutput, upstreamModel: string): ChatCompletion; fromConverseStream(stream: AsyncIterable<ConverseStreamOutput>, req: ChatCompletionRequest, upstreamModel: string): AsyncIterable<ChatCompletionChunk>; droppedParams(req: ChatCompletionRequest): string[]. Types come from AWS runtime SDK and existing adapter types. GatewayError/ProviderError are shared gateway errors. No runtime I/O.

- [ ] Write failing request tests for system/developer text; tool calls and tool/function results; adjacent user tool-result turns; inline images; auto/required/named/none tool choices; max_completion_tokens precedence and null omission. Test a remote image is dropped and reported, malformed inline bytes fail with a field-specific client error, and invalid tool JSON never silently changes intent.
- [ ] Write failing response/stream tests: text and reasoning, tool calls and partial JSON, each documented stop reason, usage input 10/cacheRead 3/cacheWrite 2/output 4 becomes prompt 15/total 19/cached 3; no invented reasoning usage. Read metadata after messageStop. Missing stop/malformed output and exception events must fail. Interleaved text/tool indices are contiguous.
- [ ] Run focused tests and confirm expected missing-module/feature failures, then implement pure functions. Handle incomplete streams and missing usage without fabricating measurements. Unknown stop reasons should be a classified upstream error.
- [ ] Cover dropped known/unknown fields and unsupported media consistently with existing translators. Report reasoning_effort and replay reasoning fields instead of building unsigned replay blocks. Do not force model-specific thinking.
- [ ] Run focused tests, full suite, typecheck/lint on owned files; self-review and commit. Record exact test evidence and any baseline failures.

### Task 2: AWS clients, discovery, adapter and gateway integration

**Files:** Create src/lib/adapters/bedrock/client.ts, errors.ts, discovery.ts, index.ts; tests/lib/adapters/bedrock/*.test.ts; tests/gateway/bedrock.test.ts. Modify src/lib/adapters/registry.ts; src/lib/gateway/protocols/{dropped,responses,embeddings,transcription}.ts; src/lib/catalog/sync.ts current messages/comments as needed; existing tests asserting Bedrock is unimplemented.

**Interfaces:** Consume Task 1 exports exactly. Export createBedrockAdapter(runtime: ProviderRuntime, factory?: BedrockClientFactory): ChatOnlyAdapter. Client factory injectable for runtime and control-plane clients; exact factory structure is builder choice, follow existing client factory patterns. Export toProviderError(err: unknown): ProviderError, preserving GatewayError/UnsupportedOperationError. Discovery returns DiscoveredModel[] through optional listModels method. Registry adds existing wrappers for translated Responses and unsupported embed/transcribe/decide.

- [ ] Write failing client tests for static keys/sessionToken, default AWS chain without credentials, region validation, custom runtime baseUrl, maxAttempts: 1, cancellation and timeout. Factory construction must not resolve credentials/network eagerly.
- [ ] Write failing discovery tests for on-demand text foundation models, active inference profile pagination, de-duplication, inherited metadata from foundation ARNs, unknown metadata left absent, and a denied/later-page failure rejecting the entire result. List calls use the caller abort signal. A runtime endpoint override must not be accidentally used for control-plane operations.
- [ ] Write failing error tests for validation/auth/not-found, throttling/not-ready/timeouts, model error 424 originalStatusCode, transport errors and embedded stream exceptions. Preserve AWS names and actionable messages; transient failures are retryable and request/configuration rejections are not.
- [ ] Write gateway tests with fake AWS transport/client (never live AWS) proving Chat/Responses, streaming usage/cost, dropped headers, direct catalog addresses, retry/failover, unsupported endpoints returning 501, mixed endpoints routing away from Bedrock, and flavor labels never bypassing Bedrock translation. Replace obsolete unimplemented-provider tests with meaningful new behavior.
- [ ] Run focused tests to see expected failures; implement clients/adapter/discovery/registry/routing. Return no list result on partial failure so existing sync preserves catalog rows. No per-model InvokeModel dialects or model-specific reasoning flags.
- [ ] Run all focused gateway/adapter tests, full suite, typecheck and lint; self-review and commit. Record exact evidence and any failures.

### Task 3: Usable AWS credential administration and documentation

**Files:** Modify src/lib/adapters/credentials.ts, src/lib/admin/providers.ts, src/app/(admin)/providers/{actions,provider-form,edit-provider-form}.tsx or .ts as appropriate, current provider/catalog comments and README.md. Extend tests/lib/admin/providers.test.ts and relevant server-action tests; pure credential tests may be added.

**Interfaces:** Existing credentialSchemas, ProviderInput, credential merge/edit semantics and form actions remain compatible for other adapters. Bedrock credentials stay region plus either explicit static keys (optional sessionToken) or useInstanceRole: true. Explicit false switches back to static keys. Follow encrypted persistence and masking rules; never expose secrets.

- [ ] Write failing credential tests for actionable missing region/accessKeyId/secretAccessKey fields, conflicting role/static inputs, role-to-static and static-to-role edits, blank fields preserving existing static credentials, and rejected mode switches leaving stored credentials untouched.
- [ ] Write failing server-action tests proving unchecked role mode is explicitly false on Bedrock edits, checked mode is true, and sessionToken crosses create/edit. Use existing action-test patterns; do not add UI implementation-detail tests.
- [ ] Implement field-specific Zod validation, correct credential merge/switching, session token create input and clear AWS default-chain copy. Reuse installed shadcn Input/Label/Switch where suitable. Read Next server/client and server-action guides before editing these files.
- [ ] Update README with Bedrock capability, automatic discovery and required IAM ListFoundationModels/ListInferenceProfiles/InvokeModel/InvokeModelWithResponseStream permissions, static/session/default chain setup, runtime baseUrl semantics, supported inline images, dropped model-specific reasoning parameters, and unsupported sibling APIs. Explain model discovery does not guarantee invocation access or Converse support.
- [ ] Remove stale current-code comments saying Bedrock has no runtime adapter; preserve historical docs. Run focused tests and full suite, lint/typecheck; self-review and commit.

### Task 4: Whole-feature review and verification

**Files:** No new product scope. Controller coordinates full-branch review and verification.

- [ ] Generate a full diff package from main to feature HEAD; request independent spec/quality review including client transport and discovery behavior. Address important findings with regression tests and scoped re-review.
- [ ] Run pnpm test, pnpm lint, pnpm typecheck and pnpm build with DATABASE_URL on the disposable 5434 database. Read exit codes and final results. Restore the original gitignored .env.test after verification.
- [ ] Confirm git diff --check and clean committed feature branch. Update plan checkboxes with evidence. Ask integration choice as required by AGENTS.md only when implementation is verified; no merge/push until chosen.
