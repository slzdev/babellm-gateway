import { expect, test } from 'vitest'
import { buildStatus } from '@/lib/status'
import { GET, HEAD } from '@/app/health/check/route'

test('reports ok with the process uptime in whole seconds', () => {
  const status = buildStatus()

  expect(status.status).toBe('ok')
  expect(Number.isInteger(status.uptime)).toBe(true)
  expect(status.uptime).toBeGreaterThanOrEqual(0)
})

test('GET answers 200 with a status body a cache will not hold on to', async () => {
  const res = await GET()

  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(await res.json()).toMatchObject({ status: 'ok' })
})

test('HEAD answers 200 with no body, for load balancers that probe with it', async () => {
  const res = await HEAD()

  expect(res.status).toBe(200)
  expect(await res.text()).toBe('')
})
