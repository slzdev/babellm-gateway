import 'server-only'
import {
  DescribeTimeToLiveCommand, DynamoDBClient, ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type { LoggingSettings } from '@/lib/settings'
import type {
  LogDetail, LogFilter, LogPage, MaintenanceResult, ReadableRequestLogStore, RequestLogEntry,
} from '../types'
import { type LogItem, toDetail, toItem, toRow } from './item'
import { SHARDS, SHARD_KEYS, boundsFor, shardKey } from './keys'
import { collectPage } from './merge'

/** Cursors and detail ids arrive from a URL. A non-uuid would produce a shard
 * key for a partition that cannot exist, so it is rejected here and read as
 * "no such row" — the same contract the Postgres driver keeps. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Everything the list view renders. Projecting these keeps the payload
 * attributes off the wire, which cuts latency — though not cost: DynamoDB
 * bills a Query on the item size read from storage, before projection. */
const LIST_ATTRIBUTES = [
  'sk', 'createdAt', 'keyName', 'model', 'stream', 'status', 'outcome', 'latencyMs',
  'ttftMs', 'finalProvider', 'finalUpstreamModel', 'promptTokens', 'completionTokens',
  'costUsd', 'payloadCaptured',
]

// Aliasing every projected attribute sidesteps DynamoDB's reserved words
// wholesale — `status` is one of them — instead of maintaining a list of
// which names happen to need it.
const PROJECTION = LIST_ATTRIBUTES.map((_, n) => `#p${n}`).join(', ')
const PROJECTION_NAMES = Object.fromEntries(
  LIST_ATTRIBUTES.map((name, n) => [`#p${n}`, name]),
)

export interface DynamoStoreConfig {
  table: string
  endpoint?: string
  region?: string
}

interface Filters {
  expression: string | undefined
  names: Record<string, string>
  values: Record<string, unknown>
}

function filtersFor(filter: LogFilter): Filters {
  const clauses: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}

  const equals = (attribute: string, value: string) => {
    names[`#f_${attribute}`] = attribute
    values[`:f_${attribute}`] = value
    clauses.push(`#f_${attribute} = :f_${attribute}`)
  }

  if (filter.apiKeyId) equals('apiKeyId', filter.apiKeyId)
  if (filter.model) equals('model', filter.model)
  if (filter.outcome) equals('outcome', filter.outcome)

  if (filter.statusClass) {
    names['#f_status'] = 'status'
    if (filter.statusClass === 'success') {
      values[':s400'] = 400
      clauses.push('#f_status < :s400')
    } else if (filter.statusClass === 'client_error') {
      values[':s400'] = 400
      values[':s499'] = 499
      clauses.push('#f_status BETWEEN :s400 AND :s499')
    } else {
      values[':s500'] = 500
      clauses.push('#f_status >= :s500')
    }
  }

  return { expression: clauses.length ? clauses.join(' AND ') : undefined, names, values }
}

/** The raw AWS error names no table, and a misconfigured DYNAMODB_LOGS_TABLE
 * is the likeliest failure here — the operator provisions the table, not the
 * gateway. */
function describe(table: string, err: unknown): unknown {
  if (err instanceof ResourceNotFoundException) {
    return new Error(
      `DynamoDB table "${table}" does not exist. Check DYNAMODB_LOGS_TABLE and the region.`,
      { cause: err },
    )
  }
  return err
}

export function createDynamoStore(config: DynamoStoreConfig): ReadableRequestLogStore {
  const raw = new DynamoDBClient({
    ...(config.region ? { region: config.region } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  })
  // removeUndefinedValues because the item mapper omits nullish attributes by
  // leaving them off entirely; without it the client rejects the write.
  const doc = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  })
  const { table } = config

  return {
    name: 'dynamodb',
    readable: true,

    async write(entry: RequestLogEntry, settings: LoggingSettings): Promise<void> {
      try {
        await doc.send(new PutCommand({ TableName: table, Item: toItem(entry, settings) }))
      } catch (err) {
        throw describe(table, err)
      }
    },

    async query(filter: LogFilter): Promise<LogPage> {
      const { lo, hi, exclude } = boundsFor(filter)
      // `before` walks toward newer rows, so it queries ascending and the
      // page is reversed at the end — the same branch as postgres.ts.
      const descending = !filter.before
      const filters = filtersFor(filter)
      // The merge's frontier invariant makes a small per-shard limit safe:
      // under-supply costs another round trip rather than a wrong answer.
      const perShard = Math.ceil((filter.limit + 1) / SHARDS) + 4

      const collected = await collectPage<LogItem>({
        shards: SHARD_KEYS,
        limit: filter.limit,
        descending,
        exclude,
        fetch: async (shard, startKey) => {
          try {
            const out = await doc.send(new QueryCommand({
              TableName: table,
              KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
              ExpressionAttributeNames: {
                '#pk': 'pk', '#sk': 'sk', ...PROJECTION_NAMES, ...filters.names,
              },
              ExpressionAttributeValues: {
                ':pk': shard, ':lo': lo, ':hi': hi, ...filters.values,
              },
              ...(filters.expression ? { FilterExpression: filters.expression } : {}),
              ProjectionExpression: PROJECTION,
              ScanIndexForward: !descending,
              Limit: perShard,
              ExclusiveStartKey: startKey,
            }))
            return {
              items: (out.Items ?? []) as LogItem[],
              scanned: out.ScannedCount ?? 0,
              lastEvaluatedKey: out.LastEvaluatedKey,
            }
          } catch (err) {
            throw describe(table, err)
          }
        },
      })

      const rows = collected.rows.map(toRow)
      const ordered = filter.before ? rows.reverse() : rows

      return {
        rows: ordered,
        nextCursor: ordered.length && (filter.before || collected.hasMore)
          ? ordered[ordered.length - 1].id
          : null,
        // On an `after` page, newer rows are guaranteed by the cursor having
        // come from a row up there. On a `before` page only hasMore knows.
        prevCursor: ordered.length && (filter.after || (filter.before && collected.hasMore))
          ? ordered[0].id
          : null,
      }
    },

    async get(id: string): Promise<LogDetail | null> {
      if (!UUID_RE.test(id)) return null
      try {
        const out = await doc.send(new GetCommand({
          TableName: table,
          Key: { pk: shardKey(id), sk: id },
        }))
        return out.Item ? toDetail(out.Item) : null
      } catch (err) {
        throw describe(table, err)
      }
    },

    /**
     * There is nothing to provision or drop: TTL is stamped on each item at
     * write time, and DynamoDB does the discarding.
     *
     * The one thing worth doing daily is checking that TTL is actually
     * enabled. The operator provisions this table, so a forgotten TTL is both
     * unbounded growth and a retention-policy violation on captured prompt
     * content — silent in every other way.
     */
    async maintain(): Promise<MaintenanceResult> {
      try {
        const out = await raw.send(new DescribeTimeToLiveCommand({ TableName: table }))
        const ttl = out.TimeToLiveDescription
        if (ttl?.TimeToLiveStatus !== 'ENABLED' || ttl?.AttributeName !== 'expiresAt') {
          console.error(
            `[gateway] DynamoDB table "${table}" has no TTL enabled on expiresAt; request logs will never expire`,
          )
        }
      } catch (err) {
        console.error(`[gateway] could not check TTL on DynamoDB table "${table}"`, err)
      }
      return { created: [], dropped: [] }
    },
  }
}

/**
 * The configured driver, or null.
 *
 * DYNAMODB_LOGS_TABLE doubles as the enable switch. A null here keeps the
 * driver out of DRIVERS entirely, which is what makes an unconfigured
 * gateway's DynamoDB support genuinely inert: the Settings picker does not
 * offer it, and runLogMaintenance never calls it.
 */
export const dynamodbStore: ReadableRequestLogStore | null = process.env.DYNAMODB_LOGS_TABLE
  ? createDynamoStore({
      table: process.env.DYNAMODB_LOGS_TABLE,
      ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
      ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
    })
  : null
