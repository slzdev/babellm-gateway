import { expect, test } from 'vitest'
import { DescribeTimeToLiveCommand, DynamoDBClient, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb'
import { createLogsTable, resetLogsTable, testDynamoConfig } from './dynamo'

const config = testDynamoConfig()
const when = config ? test : test.skip

when('the helper provisions a table with TTL enabled on expiresAt', async () => {
  await createLogsTable()

  const client = new DynamoDBClient({
    region: config!.region,
    endpoint: config!.endpoint,
  })
  const out = await client.send(new DescribeTimeToLiveCommand({ TableName: config!.table }))

  expect(out.TimeToLiveDescription?.TimeToLiveStatus).toBe('ENABLED')
  expect(out.TimeToLiveDescription?.AttributeName).toBe('expiresAt')
})

when('createLogsTable is idempotent', async () => {
  await createLogsTable()
  await expect(createLogsTable()).resolves.toBeUndefined()
})

when('resetLogsTable leaves an empty table behind', async () => {
  // A resetLogsTable that merely resolves proves nothing: createLogsTable()
  // alone also resolves to undefined against an existing table without
  // touching a single row. Put an item first and scan afterwards, so the
  // assertion actually depends on the delete-and-recreate happening.
  const client = new DynamoDBClient({
    region: config!.region,
    endpoint: config!.endpoint,
  })
  await createLogsTable()
  await client.send(new PutItemCommand({
    TableName: config!.table,
    Item: { pk: { S: 'reset-test' }, sk: { S: 'reset-test' } },
  }))

  await resetLogsTable()

  const out = await client.send(new ScanCommand({ TableName: config!.table }))
  expect(out.Count).toBe(0)
})
