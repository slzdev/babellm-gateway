# Playground design

The existing-key behavior below is specified in detail by the
[key-selection design](2026-11-04-playground-key-selection-design.md), which
supersedes the original pasted-key approach.

## Intent and scope

Add an admin page named **Playground** at `/playground` for testing configured
models through the real gateway. The user delegated feature details to the
implementer and chose subagent-driven execution on a new branch in this checkout.

The implementation choice is a chat playground: select a virtual model or a direct
catalog model, select an enabled, unexpired gateway API key, set an optional system prompt and generation
settings, and exchange multiple text turns. Replies stream, can be stopped, and
show available usage and routing metadata. A new conversation clears history.

## Constraints

- Build in the existing Next.js App Router, React, TypeScript, and shadcn/ui stack.
- Add `/playground` to the existing admin sidebar and require the admin session on the page.
- Send the selected key ID and chat payload to admin-only `POST /playground/chat` under the same-origin admin session. Resolve and revalidate the key server-side; preserve routing, key limits, cost, usage, logging, and error behavior.
- Expose only key ID, name, display prefix, and optional owner to the browser; never expose a secret or hash. Keep conversation state only in client component memory, never browser storage, URLs, or a new database table.
- Never run tests or browser checks against Postgres on 5432; use the disposable Postgres on 5434 and `pnpm dev:test-db` on port 3001.
- Preserve the pre-existing `package.json` change to the `dev` script.

## Behavior

Offer enabled virtual models that have an enabled target on an enabled provider,
and enabled-provider catalog entries of kind `chat` or `unknown`. Exclude virtual
models whose enabled targets are all known non-chat models. A direct address is
`provider/model`; preserve slashes inside upstream model IDs. Enabled virtual names
shadow direct addresses exactly as the gateway does. Missing catalog entries may
remain selectable because the gateway still serves them. Never serialize provider
credentials or API key hashes into page props. Empty lists provide links to
configure providers/models.

Use a responsive two-column layout: a compact settings card and a larger conversation
card, stacked on smaller screens. Compose installed shadcn primitives. Conversation
rendering is custom because shadcn has no chat/conversation equivalent. Render model
text as escaped plain text with whitespace preserved, plus a separate reasoning
section when provided. Avoid a new markdown dependency.

Controls: searchable model picker, existing-key selector showing name, prefix and optional owner with an API keys link, optional
system prompt, optional temperature (0–2), optional positive integer max completion
tokens, and streaming toggle (on by default). Leave optional parameters absent until
explicitly set, since providers vary in supported sampling options. Submit via button
or Ctrl/Cmd+Enter, preserve regular Enter for newlines, prevent duplicate sends,
disable configuration changes during requests, support Stop and New conversation.
Default to the first eligible API key. Model or key changes clear conversation,
draft, errors and request details. With no eligible keys, preserve model controls,
disable sending and link to API keys to create or enable a key.

Keep completed assistant turns as subsequent context. On failure or Stop, keep partial
output visibly marked and exclude it from subsequent context; retain a failed user
prompt for retry without duplicating it in the request. Abort and clean up on unmount.
Display actionable HTTP and in-stream errors, without falsely treating a truncated
stream as completed. Clear/reset must prevent late updates from an old request.

Show request latency, provider/upstream model, tokens and cost when returned, request
ID linking to the request log, and dropped-parameter notice where applicable. Unknown
usage/cost stays unknown. Do not execute tools or upload media in this version.

## Approaches considered

1. **Admin-only execution endpoint (current approach):** resolves the selected
   existing key server-side and uses the shared gateway lifecycle for accounting,
   routing and limits. The public API continues to require Bearer credentials.
2. **Browser client of the public gateway (original approach, superseded):** required
   pasting a secret. The existing-key selector avoids sending secrets to the browser.
3. **Multi-endpoint API workbench:** covers embeddings/audio/decisions but requires
   different inputs and response displays; outside this first chat-focused page.

## Verification

Test model availability and shadowing using the disposable database. Test the browser
stream reader with fragmented UTF-8, CRLF, usage-only frames, reasoning, gateway error
events, and EOF before `[DONE]`. Test request validation/history construction where
behavior warrants it. Run lint, type checking, full suite, production build, and an
isolated browser check with a local fake provider; never call configured real providers
or change the developer's database.
