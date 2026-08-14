import {
  CreateTableCommand, DeleteTableCommand, DynamoDBClient,
  ResourceInUseException, ResourceNotFoundException,
  UpdateTimeToLiveCommand, waitUntilTableExists, waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb'

/**
 * The disposable DynamoDB Local, or null when it is not configured.
 *
 * Reads TEST_DYNAMODB_*, never DYNAMODB_LOGS_TABLE: the latter registers the
 * driver for the whole suite. A null return is how the DynamoDB tests skip on
 * a checkout that has not started the container.
 */
export function testDynamoConfig(): { table: string; endpoint: string; region: string } | null {
  const table = process.env.TEST_DYNAMODB_TABLE
  const endpoint = process.env.TEST_DYNAMODB_ENDPOINT
  if (!table || !endpoint) return null
  return { table, endpoint, region: process.env.AWS_REGION ?? 'us-east-1' }
}

function client(): DynamoDBClient {
  const config = testDynamoConfig()
  if (!config) throw new Error('TEST_DYNAMODB_TABLE / TEST_DYNAMODB_ENDPOINT are not set')
  return new DynamoDBClient({ region: config.region, endpoint: config.endpoint })
}

// The budget createLogsTable gives the container to accept a connection.
// `pnpm test:db:up` starts three containers at once, and JVM class-loading
// under that contention is a known source of slower amazon/dynamodb-local
// boots than a lone container on an idle machine shows. 18s is comfortable
// headroom even there; it only ever gets spent when the container genuinely
// isn't up yet.
const READY_TIMEOUT_MS = 18_000
const INITIAL_RETRY_DELAY_MS = 200
const MAX_RETRY_DELAY_MS = 1_000

/**
 * Creates the table the production driver expects, with TTL enabled.
 *
 * Idempotent, and it retries while the container finishes booting: the
 * compose service carries no healthcheck (the image has no curl or wget), so
 * this is where readiness is actually established. Backoff doubles from
 * INITIAL_RETRY_DELAY_MS up to MAX_RETRY_DELAY_MS so a container that is
 * already warm (the common case, after the first call in a run) barely
 * pays for the retry loop at all, while one still booting gets the full
 * READY_TIMEOUT_MS budget.
 */
export async function createLogsTable(): Promise<void> {
  const config = testDynamoConfig()
  if (!config) throw new Error('TEST_DYNAMODB_TABLE / TEST_DYNAMODB_ENDPOINT are not set')
  const db = client()

  const deadline = Date.now() + READY_TIMEOUT_MS
  let delay = INITIAL_RETRY_DELAY_MS
  for (;;) {
    try {
      await db.send(new CreateTableCommand({
        TableName: config.table,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }))
      break
    } catch (err) {
      if (err instanceof ResourceInUseException) return
      if (Date.now() >= deadline) {
        throw new Error(
          `DynamoDB Local at ${config.endpoint} did not accept a connection within ` +
          `${READY_TIMEOUT_MS}ms. Is the container running? Check with: ` +
          `docker compose -f docker-compose.test.yml logs dynamodb-test`,
          { cause: err },
        )
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
    }
  }

  await waitUntilTableExists({ client: db, maxWaitTime: 30 }, { TableName: config.table })
  await db.send(new UpdateTimeToLiveCommand({
    TableName: config.table,
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  }))
}

/**
 * The DynamoDB counterpart of resetDb(): a known-empty slate between tests.
 *
 * Drop and recreate rather than scan and delete. On an in-memory local
 * instance that is both faster and unconditional — a scan-and-delete leaves
 * behind anything written while it ran.
 */
export async function resetLogsTable(): Promise<void> {
  const config = testDynamoConfig()
  if (!config) throw new Error('TEST_DYNAMODB_TABLE / TEST_DYNAMODB_ENDPOINT are not set')
  const db = client()

  try {
    await db.send(new DeleteTableCommand({ TableName: config.table }))
    await waitUntilTableNotExists({ client: db, maxWaitTime: 30 }, { TableName: config.table })
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err
  }

  await createLogsTable()
}
