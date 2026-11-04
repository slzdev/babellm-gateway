# Playground existing-key selection

Replace the gateway secret input with a picker of existing active API keys. This
supersedes the pasted-key behavior in the original Playground design. The user
previously chose subagent execution on `codex/playground`, delegated implementation
details, and asked to keep this branch; those choices continue to apply.

## Behavior

List enabled, unexpired keys by name, with their display prefix and optional assigned
user to distinguish duplicate names. Default to the first available key. Selecting
another key starts a fresh conversation. With no usable keys, show an API keys link
and disable sending. Keep the existing full-width layout, readable model selector,
generation controls, streaming, cancellation, reasoning, metadata, and log links.

The browser receives only key ID, name, display prefix, and assigned user name. It
sends `apiKeyId` plus the ordinary chat payload to `POST /playground/chat`; it never
receives a key hash or secret and no longer sends a Bearer token.

## Architecture and alternatives

Keys are stored only as one-way hashes, so a picker cannot recover their original
secrets. Chosen approach: an admin-only chat route resolves the selected ID on the
server and passes that key into the shared gateway lifecycle. Avoid storing new
recoverable secrets, rotating keys, minting surrogate keys, or allowing IDs to
authenticate the public API.

Add an optional server-only key resolver to the existing gateway dependency object.
Default behavior still resolves the Bearer token, so every existing `/v1` route
continues to require its normal credentials. The Playground supplies a resolver that
looks up and validates the selected key afresh on every request. Disabled, expired,
deleted, and malformed IDs fail before any provider call. Normal rate limits,
budgets, usage, payload-capture settings, last-used timestamps, routing and logs all
apply to the selected key, including streamed requests.

The route independently checks the admin session (layouts do not protect routes),
rejecting unauthenticated requests with a JSON 401. It rejects missing, malformed or
cross-origin Origin headers with JSON 403. Compare the parsed HTTP(S) Origin host to
the forwarded host (first `x-forwarded-host`), Host, or request URL host in that
order, matching common reverse-proxy behavior; reject `Sec-Fetch-Site` values other
than `same-origin` when supplied. Browser clients cannot set these forbidden origin
and fetch metadata headers. No permissive CORS response is added.

After access checks, validate a UUID key ID, remove it from the forwarded chat body,
set `source=playground` tags on the server, and propagate the request's AbortSignal.
Ignore inbound Bearer credentials for this route: the explicitly selected key is the
only identity. Return the gateway Response directly to preserve streaming and
metadata. Reuse existing error envelopes. Do not add a schema migration or dependency.

## Constraints and verification

- Never expose API key hashes or plaintext secrets to the client.
- Public `/v1` authentication must remain Bearer-token-only.
- Every Playground execution requires a valid admin session and same-origin access checks.
- The selected key is revalidated on each request and owns all accounting and logging.
- Test and browser traffic uses only disposable Postgres on port 5434; browser checks use port 3001.
- Preserve the existing model selector readability, full-width layout, streaming and cancellation behavior.

Use real disposable DB tests for eligible-key options, key status validation,
selected-key logging/usage/limits, and payload capture. Use a fake adapter for upstream
execution and actual Response/ReadableStream objects. Test session/origin refusals,
malformed/missing/deleted/disabled/expired IDs, forged Authorization/ID attempts on
the public endpoint, JSON and SSE replies, proxy host handling, and signal forwarding.
Update request-builder tests for key IDs. Run full tests, lint, typecheck, production
build and a disposable fake-provider browser check for selection, chat, errors and
empty keys. No real providers or development database access.
