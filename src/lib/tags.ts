/**
 * The `x-babellm-tags` header: caller-supplied `key=value` pairs recorded on
 * the request log.
 *
 * This module imports nothing, deliberately. It is the shared vocabulary
 * between the gateway ingress and the `/logs` filter bar, and the filter bar
 * is a Client Component — so anything imported here enters the browser
 * bundle. The throwing wrapper lives in `@/lib/gateway/tags` instead, because
 * `GatewayError` pulls in the OpenAI SDK. Same reasoning as
 * `@/lib/admin/log-filter-params`.
 */

export const TAGS_HEADER = 'x-babellm-tags'

/** Raw header bytes, not characters: a header is a byte budget, and counting
 * characters would let a multi-byte value smuggle in twice the size. */
const MAX_BYTES = 2048
const MAX_TAGS = 16
const MAX_VALUE_LENGTH = 256

const KEY_RE = /^[a-z0-9_.-]{1,64}$/
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * A result rather than an exception, because the two callers disagree about
 * what a bad tag means. The gateway turns a failure into a 400; the admin
 * filter drops it and shows the default view, per parseLogFilter's
 * "a hand-edited URL should show a view, not an error page" contract.
 */
export type TagParse =
  | { ok: true; tags: Record<string, string> | null }
  | { ok: false; message: string }

function fail(message: string): TagParse {
  return { ok: false, message: `${TAGS_HEADER}: ${message}` }
}

/**
 * Parses a raw `x-babellm-tags` value.
 *
 * Absent, empty, or whitespace-only all yield `tags: null` — "no tags sent" —
 * never `{}`. The write path stores that `null` as SQL NULL, which is what
 * keeps "sent no tags" distinguishable from a row written before this feature
 * existed.
 */
export function parseTags(raw: string | null | undefined): TagParse {
  if (raw == null) return { ok: true, tags: null }

  // Size first, so an abusive header is rejected before anything iterates it.
  const bytes = new TextEncoder().encode(raw).length
  if (bytes > MAX_BYTES) {
    return fail(`header is at most ${MAX_BYTES} bytes, got ${bytes}`)
  }

  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, tags: null }

  const tokens = trimmed.split(',')
  if (tokens.length > MAX_TAGS) {
    return fail(`at most ${MAX_TAGS} tags, got ${tokens.length}`)
  }

  const tags: Record<string, string> = {}
  for (const token of tokens) {
    // The first `=` only: the key charset excludes `=`, so `note=a=b` is
    // unambiguously the key `note` with the value `a=b`, and no escaping
    // rule is needed.
    const split = token.indexOf('=')
    if (split === -1) return fail(`"${token.trim()}" is not a key=value pair`)

    const key = token.slice(0, split).trim().toLowerCase()
    const value = token.slice(split + 1).trim()

    if (!KEY_RE.test(key)) return fail(`key "${key}" is not a valid tag key`)
    if (value === '') return fail(`tag "${key}" has an empty value`)
    if (value.length > MAX_VALUE_LENGTH) {
      return fail(
        `value for "${key}" is at most ${MAX_VALUE_LENGTH} characters, got ${value.length}`,
      )
    }
    if (CONTROL_RE.test(value)) {
      return fail(`value for "${key}" contains a control character`)
    }
    // After lowercasing, so `env` and `ENV` collide as the caller intended
    // them to. Rejecting beats last-wins: silently dropping half of an
    // ambiguous header is the failure mode this whole feature refuses.
    if (Object.hasOwn(tags, key)) return fail(`duplicate key "${key}"`)

    tags[key] = value
  }

  return { ok: true, tags }
}
