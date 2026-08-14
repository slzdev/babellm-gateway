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

/**
 * Creates the table the production driver expects, with TTL enabled.
 *
 * Idempotent, and it retries while the container finishes booting: the
 * compose service carries no healthcheck (the image has no curl or wget), so
 * this is where readiness is actually established.
 */
export async function createLogsTable(): Promise<void> {
  const config = testDynamoConfig()
  if (!config) throw new Error('TEST_DYNAMODB_TABLE / TEST_DYNAMODB_ENDPOINT are not set')
  const db = client()

  for (let attempt = 0; ; attempt += 1) {
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
      // Connection refused while the JVM starts. Ten attempts at 300ms is
      // comfortably longer than DynamoDB Local takes to accept a socket.
      if (attempt >= 10) throw err
      await new Promise((resolve) => setTimeout(resolve, 300))
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
