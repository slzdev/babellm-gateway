import { test } from 'vitest'
import { createRedisHealthStore } from '@/lib/health/redis'
import { describeHealthStoreContract } from './store-contract'

const url = process.env.TEST_REDIS_URL

if (url) {
  describeHealthStoreContract('redis', () => createRedisHealthStore(url))
} else {
  test.skip('redis health driver contract (set TEST_REDIS_URL and run pnpm test:db:up)', () => {})
}
