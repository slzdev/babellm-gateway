import { randomBytes } from 'node:crypto'

/** rand_a — the 12 bits after the version nibble — is used as a per-millisecond
 * sequence counter, which is RFC 9562 §6.2's "monotonic random" method. */
const MAX_COUNTER = 0xfff

let lastMs = -1
let counter = 0

/**
 * uuid v7: a 48-bit big-endian millisecond timestamp, a 12-bit monotonic
 * counter, and 62 random bits.
 *
 * Generated here rather than by the database because `uuidv7()` is a Postgres
 * 18 builtin and compose pins postgres:17 — and because app-side generation
 * works on whatever version a self-hoster runs.
 *
 * The counter is what lets the log viewer call `ORDER BY id DESC`
 * chronological: without it, two requests landing in the same millisecond
 * would sort at random.
 */
export function uuidv7(date: Date = new Date()): string {
  const ms = date.getTime()
  if (ms === lastMs) {
    // Saturating rather than wrapping: wrapping would sort a later id below an
    // earlier one, which is the exact property the counter exists to provide.
    // Reaching 4096 ids inside one millisecond means over four million per
    // second, at which point ordering within that millisecond degrades to
    // random and nothing else breaks — ids stay unique via rand_b.
    counter = counter < MAX_COUNTER ? counter + 1 : MAX_COUNTER
  } else {
    lastMs = ms
    counter = 0
  }
  return format(compose(ms, counter, randomBytes(8)))
}

/**
 * The lowest uuid v7 that can exist for a timestamp: same time bits, counter
 * and random bits all zero. `id >= uuidv7Bound(t)` therefore selects exactly
 * the rows written at or after `t` — a range scan on the primary key, which is
 * why request_logs needs no created_at index.
 */
export function uuidv7Bound(date: Date): string {
  return format(compose(date.getTime(), 0, new Uint8Array(8)))
}

function compose(ms: number, seq: number, random: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(16)

  // Bit shifts are 32-bit in JS and this value is 48-bit, so the high bytes
  // are divided out rather than shifted.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff

  // Version 7 in the high nibble, then the 12-bit counter.
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f)
  bytes[7] = seq & 0xff

  bytes.set(random, 8)
  // Variant 10xx. 0x70 and 0x80 are the smallest legal values of these two
  // bytes, which is what keeps a zeroed bound genuinely minimal.
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return bytes
}

function format(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20),
  ].join('-')
}
