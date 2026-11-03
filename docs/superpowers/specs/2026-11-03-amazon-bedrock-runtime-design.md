# Amazon Bedrock Runtime provider

## Intent and scope

Make the existing `bedrock` provider usable through the gateway's Chat Completions and Responses endpoints, with streaming, tools, inline images, usage/cost accounting, failover, and automatic Catalog discovery. The user selected subagent-driven execution, a new branch in the original workspace, and automatic discovery.

## Approaches

1. Native AWS Converse/ConverseStream with manual Catalog entries: smallest dependency and IAM surface, but requires operators to enter model IDs themselves.
2. Native AWS Converse/ConverseStream plus control-plane discovery: the selected approach. Add `@aws-sdk/client-bedrock-runtime` and `@aws-sdk/client-bedrock`; discover foundation models and inference profiles using the same region and credentials.
3. AWS's OpenAI-compatible endpoint: less translation, but supports a smaller set of model families and does not fit the existing native Bedrock credential contract as directly.

## Runtime and translation

- Follow the existing adapter layout: injectable SDK client factory, Bedrock error classifier, and a pure `chat-to-bedrock` translator. Use ConverseCommand/ConverseStreamCommand. Preserve upstream model/profile IDs and ARNs unchanged. No schema migration is needed.
- Hoist system/developer text, map user/assistant messages and tool calls/results, including the legacy `function` role; combine adjacent same-role turns where needed for multiple tool results. Preserve tool IDs and JSON arguments. Map max token limits, temperature, top_p, stop, and supported tool choices. `tool_choice: none` withholds tools; auto/required/named choices map to AWS auto/any/tool.
- Accept inline base64 PNG/JPEG/GIF/WebP image parts as SDK byte sources. Do not fetch remote URLs. Follow the project's compatibility policy: report unsupported content and parameters in the dropped-params header/log rather than silently omitting them. Invalid inline data is a clear client error.
- Translate text, tool calls, finish reasons and returned reasoning text. Reasoning configuration is model-specific, so generic `reasoning_effort` is reported as dropped; do not invent a cross-model mapping. Do not construct signed reasoning replay from plain text. Provider requestReasoningSummary cannot force model-independent reasoning.
- Streams relay text/reasoning and partial tool JSON, preserving tool IDs and assigning contiguous OpenAI tool indices. Read metadata after messageStop. Exception members and thrown stream errors are classified as provider failures. Never invent success for malformed/incomplete streams.
- Normalize prompt tokens as inputTokens + cacheReadInputTokens + cacheWriteInputTokens, cached tokens as cacheReadInputTokens, completion tokens as outputTokens, and total as normalized input plus output. Do not fabricate reasoning-token counts.
- Thread caller cancellation into every SDK operation; honor provider timeoutMs and disable SDK retries so gateway failover owns attempts. Use static credentials including sessionToken, or omit explicit credentials for the AWS default credential chain (environment/profile/workload role). No credentials are logged.

## Discovery

Use a separate Bedrock control-plane client. List on-demand text foundation models and paginate active inference profiles, de-duplicating by ID. Map only metadata AWS actually reports; infer profile metadata from referenced foundation model ARNs when available. Do not claim tool support or token limits from absent fields. Foundation model discovery does not guarantee account access or Converse support: AWS remains authoritative at invocation time. If either required listing fails, fail the sync without returning a partial catalog, preserving existing rows through the current sync behavior. All calls receive the discovery abort signal.

## Integration and configuration

Compose existing Responses and unsupported-operation wrappers in the registry. Bedrock remains independent of stored OpenAI chat flavor labels. Filter Bedrock out of mixed embeddings/transcription routes, with clear 501 responses for Bedrock-only routes; Decisions remains unsupported. Fix dropped-parameter selection and Responses flavor handling so Bedrock never gets mistaken for a native OpenAI transport.

Make AWS authentication configuration usable: actionable field errors, session token on create, explicit role/static switching on edit, no silently discarded conflicting keys, and clear copy describing default AWS credential resolution. Reuse current shadcn form primitives. Update current README capability and setup documentation, including inference and discovery IAM permissions; historical specs remain historical.

## Verification and constraints

Tests use the disposable Postgres on 5434, copied from `.env.test.example`, with a feature-specific database name. Never use the developer database on 5432 or stop the shared test containers. Cover pure request/response/stream translation, credentials/client construction, error classification, discovery pagination and failure behavior, registry/unsupported routing, dropped parameters, gateway Chat/Responses delivery and failover. Run the full suite, lint, typecheck and a production build when practical. Mocked AWS evidence is distinguished from live AWS validation; no real AWS account credentials are required.

## Non-goals and builder decisions

No Bedrock-specific embeddings/InvokeModel payloads, audio transcription, Decisions, hosted/stateful Responses, remote-media downloader, model-specific reasoning configuration, guardrail UI, or new client-facing endpoints. Exact helper names and test factoring are left to the implementers, within the existing architecture.

## Primary references

- https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
- https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
- https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStreamOutput.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html
- https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html
- https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
