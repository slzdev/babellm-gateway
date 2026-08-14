/**
 * The UTC hour a uuid v7 encodes, as SQL.
 *
 * Postgres 18 has uuid_extract_timestamp(); compose pins postgres:17, which
 * is also why src/lib/uuid.ts mints ids in the application. So the timestamp
 * is unpacked here by hand:
 *
 *   - the first 48 bits of a v7 uuid are a big-endian millisecond timestamp
 *   - which is exactly the first 12 hex characters of the dashless text form
 *   - `'x' || hex` cast to bit(48) is Postgres's hex bit-string literal
 *   - and to_timestamp() takes it from milliseconds to a timestamptz
 *
 * The zone argument to date_trunc is load-bearing. Without it, date_trunc
 * truncates a timestamptz in the session's TimeZone. Under a fractional-offset
 * zone like Asia/Kolkata (+5:30), the same row buckets differently depending on
 * who connected and when — every total depends on the observer's TimeZone.
 * Three-argument date_trunc is Postgres 16+.
 *
 * The counterpart of uuidv7Bound(): that turns an instant into a key bound,
 * this turns a key back into an instant. tests/lib/stats/sql.test.ts asserts
 * the two agree, because a disagreement would have the rollup job deleting
 * rows for one hour and inserting rows for another.
 */
export function bucketExpr(alias: string): string {
  return `date_trunc('hour', to_timestamp(` +
    `('x' || substring(replace(${alias}.id::text, '-', '') from 1 for 12))::bit(48)::bigint` +
    ` / 1000.0), 'UTC')`
}
