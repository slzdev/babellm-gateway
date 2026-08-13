/**
 * Cuts at a UTF-8 character boundary at or below maxBytes. Slicing blind and
 * letting the decoder clean up does not work: a partial sequence becomes
 * U+FFFD, which re-encodes to three bytes and can push the preview back over
 * the cap it was supposed to enforce.
 */
function sliceToBoundary(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buffer.length)
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

/**
 * Bounds what a payload can cost in the database.
 *
 * An oversized payload is replaced rather than clipped: a truncated JSON
 * string is not valid JSON, and the column is jsonb. The envelope keeps the
 * column honestly typed and gives the UI exactly one shape to parse.
 */
export function capPayload(
  value: unknown,
  maxBytes: number,
): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false }

  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? 'null'
  } catch {
    // A cyclic or otherwise unserializable body must not take down the log
    // write that mentions it.
    return { value: { truncated: true, error: 'unserializable' }, truncated: true }
  }

  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= maxBytes) return { value, truncated: false }

  return {
    value: {
      truncated: true,
      bytes,
      // Sliced on bytes, not characters, so a multi-byte character near the
      // boundary cannot push the preview back over the cap.
      preview: sliceToBoundary(Buffer.from(serialized, 'utf8'), maxBytes),
    },
    truncated: true,
  }
}
