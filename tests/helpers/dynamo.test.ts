import { expect, test } from 'vitest'
import {
  DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient,
  PutItemCommand, ScanCommand,
} from '@aws-sdk/client-dynamodb'
import { createLogsTable, resetLogsTable, testDynamoConfig } from './dynamo'

const config = testDynamoConfig()
const when = config ? test : test.skip

when('the helper provisions a table with TTL enabled on expiresAt', async () => {
  await createLogsTable()

  const client = new DynamoDBClient({
    region: config!.region,
    endpoint: config!.endpoint,
  })
  const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: config!.table }))

  expect(ttl.TimeToLiveDescription?.TimeToLiveStatus).toBe('ENABLED')
  expect(ttl.TimeToLiveDescription?.AttributeName).toBe('expiresAt')

  // pk/sk with the KeyType roles swapped, or sk dropped entirely, are both
  // structurally valid DynamoDB schemas — CreateTableCommand would not
  // complain, and nothing above reads in a way that would notice (Scan is
  // unkeyed). Task 7's driver assumes pk is the partition key and sk the
  // sort key; check that directly rather than let a mistake here surface
  // there as an unexplained Query failure.
  const desc = await client.send(new DescribeTableCommand({ TableName: config!.table }))
  const keySchema = desc.Table?.KeySchema ?? []
  expect(keySchema.find((k) => k.AttributeName === 'pk')?.KeyType).toBe('HASH')
  expect(keySchema.find((k) => k.AttributeName === 'sk')?.KeyType).toBe('RANGE')
  const attrTypes = new Map(
    (desc.Table?.AttributeDefinitions ?? []).map((a) => [a.AttributeName, a.AttributeType]),
  )
  expect(attrTypes.get('pk')).toBe('S')
  expect(attrTypes.get('sk')).toBe('S')
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
