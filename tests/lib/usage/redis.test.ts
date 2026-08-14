import { test } from 'vitest'
import { createRedisStore } from '@/lib/usage/redis'
import { describeStoreContract } from './store-contract'

const url = process.env.TEST_REDIS_URL

if (url) {
  describeStoreContract('redis', () => createRedisStore(url))
} else {
  test.skip('redis driver contract (set TEST_REDIS_URL and run pnpm test:db:up)', () => {})
}
