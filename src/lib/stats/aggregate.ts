import 'server-only'
import { uuidv7Bound } from '@/lib/uuid'
import type { HourRange } from './buckets'
import { bucketExpr } from './sql'

/** The subset of a `pg` client this module needs. Narrow on purpose: the
 * caller owns the transaction and the connection, because the lock in
 * rollup.ts must be taken on the same session. */
export interface RollupClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

/**
 * Rebuilds every rollup bucket in `range` from request_logs.
 *
 * Delete-and-reinsert, never `ON CONFLICT DO UPDATE SET x = x + excluded.x`.
 * Incrementing is correct only if every row is counted exactly once, and
 * nothing here provides that invariant: a retried tick, an overlapping range,
 * or a partially-failed run each double-counts silently and permanently, with
 * no way to detect it afterwards and no repair short of a full rebuild.
 * Recompute converges on the same numbers however many times it runs, and it
 * also removes a combination that stopped occurring — which an increment
 * never does.
 *
 * The caller opens the transaction: a DELETE that commits without its INSERT
 * would leave those hours permanently zeroed.
 *
 * `range` must be hour-aligned — both bounds are expected to fall on the
 * hour, as `hourStart()` guarantees. The DELETE clears whole buckets by
 * `bucket`, which is always hour-aligned; a `from` of 13:30 would still
 * insert into the 13:00 bucket (bucketExpr floors to the hour) but the
 * DELETE would only have cleared bucket >= 13:30, leaving the 13:00 row's
 * old contents un-deleted underneath the new INSERT and tripping the unique
 * constraint. Every current caller satisfies this: `unsealedRange` and
 * `backfillChunk` both route their bounds through `hourStart`.
 *
 * Returns the number of rollup rows written.
 */
export async function aggregateRange(
  client: RollupClient,
  range: HourRange,
): Promise<number> {
  await client.query(
    'DELETE FROM usage_rollups WHERE bucket >= $1 AND bucket < $2',
    [range.from, range.to],
  )

  // The id range is the same primary-key trick /logs uses for its date
  // filters (src/lib/logs/postgres.ts:49): a v7 id encodes its own timestamp,
  // so a time window is a PK range scan with partition pruning rather than a
  // sequential scan over a table that grows forever.
  const result = await client.query(
    `
    INSERT INTO usage_rollups (
      bucket, api_key_id, user_id, model, provider, status_class,
      key_name, user_name,
      requests, unpriced_requests,
      prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
      input_cost_usd, cached_cost_usd, output_cost_usd, cost_usd,
      latency_sum_ms, latency_max_ms, latency_count, ttft_sum_ms, ttft_count
    )
    SELECT
      ${bucketExpr('rl')},
      rl.api_key_id,
      ak.user_id,
      rl.model,
      rl.final_provider,
      (CASE
         WHEN rl.status < 400 THEN 'success'
         WHEN rl.status < 500 THEN 'client_error'
         ELSE 'server_error'
       END)::status_class,
      -- Labels, not grain. key_name is denormalized into request_logs at
      -- write time, so renaming a key mid-hour puts two names on rows sharing
      -- every grain column; grouping by the name would emit two rows for one
      -- grain and the unique constraint would reject the second.
      max(rl.key_name),
      max(u.name),
      count(*)::int,
      (count(*) FILTER (WHERE rl.cost_usd IS NULL))::int,
      coalesce(sum(rl.prompt_tokens), 0),
      coalesce(sum(rl.completion_tokens), 0),
      coalesce(sum(rl.cached_tokens), 0),
      coalesce(sum(rl.reasoning_tokens), 0),
      coalesce(sum(rl.input_cost_usd), 0),
      coalesce(sum(rl.cached_cost_usd), 0),
      coalesce(sum(rl.output_cost_usd), 0),
      coalesce(sum(rl.cost_usd), 0),
      coalesce(sum(rl.latency_ms), 0),
      coalesce(max(rl.latency_ms), 0),
      count(rl.latency_ms)::int,
      coalesce(sum(rl.ttft_ms), 0),
      count(rl.ttft_ms)::int
    FROM request_logs rl
    LEFT JOIN api_keys ak ON ak.id = rl.api_key_id
    LEFT JOIN users u ON u.id = ak.user_id
    WHERE rl.id >= $1 AND rl.id < $2
    GROUP BY 1, 2, 3, 4, 5, 6
    `,
    [uuidv7Bound(range.from), uuidv7Bound(range.to)],
  )

  return result.rowCount ?? 0
}
