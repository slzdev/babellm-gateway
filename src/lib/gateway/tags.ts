import 'server-only'
import { TAGS_HEADER, parseTags } from '@/lib/tags'
import { GatewayError } from './errors'

/**
 * Reads and validates `x-babellm-tags` off an inbound request.
 *
 * Throws rather than degrading, unlike the admin filter's use of the same
 * parser: a caller who typos a tag and is not told gets a dashboard quietly
 * missing a slice of its traffic, undetectable from either side. A 400 in
 * development costs a minute; a silently short count costs the trust in every
 * count on the page.
 *
 * A repeated header line needs no handling here — Headers.get() joins repeats
 * with ", ", which is already the pair separator.
 */
export function tagsFromRequest(request: Request): Record<string, string> | null {
  const result = parseTags(request.headers.get(TAGS_HEADER))
  if (!result.ok) {
    throw new GatewayError({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_tags',
      message: result.message,
    })
  }
  return result.tags
}
