# `reasoning_effort` on the Bedrock adapter

## Intent

`reasoning_effort` on `/v1/chat/completions` is silently dropped by the
Bedrock adapter today (reported in `x-babellm-dropped-params`). Clients
should be able to steer reasoning for Claude and OpenAI models served by
Bedrock, and **new models of either family must work without code
changes**.

## Goals / non-goals

- Goal: translate `reasoning_effort` into each family's native
  `additionalModelRequestFields` shape on Converse and ConverseStream.
- Goal: new `anthropic.*` / `openai.*` model IDs work with no list update.
- Non-goal: per-turn effort betas, preserved thinking, Responses or Mantle
  endpoints on Bedrock.
- Non-goal: validating effort values per model. An unsupported value (e.g.
  `xhigh` on Haiku 5.5, `none` on GPT-6 Astra) is a 400 from upstream, the
  same "forward verbatim" stance the schema and the Anthropic adapter take.
- Anti-goal: breaking requests for families that never asked for reasoning
  (Meta, Mistral, DeepSeek, opaque application-inference-profile ARNs).

## Approaches

1. **Model-ID allowlist** (like prompt caching): safe, but every new model
   needs a code change.
2. **Prefix-based family detection** — chosen by the user, because new
   models must work without code changes. Accepts that an unknown future
   shape would fail upstream rather than be dropped.

## Design

All of this lives in `src/lib/translate/chat-to-bedrock.ts`.

### Family detection

Take the ID after the last `/` (ARNs end in the model ID), strip an
optional region/geo prefix (`us.`, `eu.`, `apac.`, `global.`, …), then:

- `anthropic.claude-*` → Claude
- `openai.*` → OpenAI
- anything else → unsupported: no change to the request; `reasoning_effort`
  stays in `droppedParams`.

### Effort normalisation (shared)

- Absent / empty → no reasoning config (unless the provider opt-in below).
- `none` → no reasoning config at all, mirroring `chat-to-anthropic.ts`.
  Claude 5+ still thinks adaptively by default; that is accepted.
- Claude only: `minimal` → `low` (reuse the Anthropic adapter's alias).
  OpenAI: forwarded verbatim.

### Claude

Adaptive (default for every Claude ID, so new models need nothing):

```json
{ "thinking": { "type": "adaptive", "display": "summarized" },
  "output_config": { "effort": "<effort>" } }
```

`display: "summarized"` because Claude 5+ default to `omitted`, which
returns empty thinking text.

Legacy budget-only models — a closed list that can never grow: Claude
3.7 Sonnet, Sonnet 4, Opus 4, Opus 4.1, Sonnet 4.5, Haiku 4.5, Opus 4.5.

```json
{ "thinking": { "type": "enabled", "budget_tokens": <budget> } }
```

Budget map: `low` 2048, `medium` 8192, `high` 16384; any other value
(`xhigh`, `max`, …) uses `high`'s budget. `budget_tokens` must be below
`maxTokens`: when the client gave no max, set `inferenceConfig.maxTokens`
to `budget + 4096`; when it did and it is ≤ budget, lower the budget to
`maxTokens - 1`; if that is below 1024 (Anthropic's minimum), send no
thinking and report `reasoning_effort` as dropped.

Claude 3.0 / 3.5 have no thinking: treat as unsupported (dropped).

### OpenAI

```json
{ "reasoning": { "effort": "<effort>", "summary": "auto" } }
```

Shape taken from AWS's GPT-on-Bedrock blog example; `reasoning.summary` is
documented on the GPT-6.x model cards for Converse. Without `summary` no
reasoning text comes back.

### Provider opt-in

`ProviderConfig.requestReasoningSummary === true` requests reasoning even
with no effort (Claude: adaptive thinking without `output_config`, or the
`medium` budget for legacy; OpenAI: `reasoning: {summary: "auto"}`), and
never when the client sent `none` — same semantics as the other adapters.
This means `toConverseRequest` needs the provider config passed in from
`createBedrockAdapter` (`runtime.config`).

### Merging

`additionalModelRequestFields` merges reasoning fields with the existing
automatic-cache `cache_control`; neither may overwrite the other.

### droppedParams

`reasoning_effort` is no longer reported when it was translated. It is
still reported for unsupported families and for the legacy-budget case
where no valid budget fits.

### Response side

Unchanged: `reasoningContent` already maps to `reasoning_content` in both
non-streaming and streaming paths.

## Verification

Unit tests in `tests/` for `toConverseRequest` and `droppedParams`
covering: each family, region-prefixed and ARN IDs, `none`, `minimal`,
legacy budget clamping, cache + reasoning merge, provider opt-in,
unsupported family. Tests run against the 5434 test database only.

Not verifiable here: a live Bedrock call. The `display` field on Converse
and the OpenAI `reasoning.effort` shape come from docs; the user confirms
them against real Bedrock.

## Calls made by the designer (not discussed)

- Budget numbers and the `budget + 4096` default max.
- Claude 3.0/3.5 treated as unsupported.
- `reasoning.summary: "auto"` always sent with an OpenAI effort.
