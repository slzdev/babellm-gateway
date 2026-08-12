import { afterEach, expect, test, vi } from 'vitest'
import { buildRequestLog, emitRequestLog } from '@/lib/gateway/request-log'
import type { AttemptRecord } from '@/lib/gateway/execute'

function attempt(patch: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    n: 1,
    targetId: 'target-a',
    provider: 'openai',
    model: 'gpt-4o-mini',
    status: 200,
    latencyMs: 120,
    ...patch,
  }
}

function fields(patch: Partial<Parameters<typeof buildRequestLog>[0]> = {}) {
  return {
    requestId: 'req_a1b2',
    key: 'prod-app',
    model: 'gpt-fast',
    stream: false,
    status: 200,
    outcome: 'ok' as const,
    latencyMs: 1042,
    attempts: [attempt()],
    ...patch,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('the line carries the request identity and outcome in snake_case', () => {
  expect(buildRequestLog(fields())).toMatchObject({
    lvl: 'info',
    msg: 'gateway.request',
    request_id: 'req_a1b2',
    key: 'prod-app',
    model: 'gpt-fast',
    stream: false,
    status: 200,
    outcome: 'ok',
    latency_ms: 1042,
  })
})

test('attempts are flattened to the fields a reader needs', () => {
  const line = buildRequestLog(fields({
    attempts: [
      attempt({ n: 1, provider: 'openai', status: 429, latencyMs: 212, error: 'rate_limit_exceeded: slow down' }),
      attempt({ n: 2, provider: 'groq', model: 'llama-3.3-70b', status: 200, latencyMs: 830 }),
    ],
  }))

  expect(line.attempts).toEqual([
    { n: 1, provider: 'openai', model: 'gpt-4o-mini', status: 429, latency_ms: 212, error: 'rate_limit_exceeded: slow down' },
    { n: 2, provider: 'groq', model: 'llama-3.3-70b', status: 200, latency_ms: 830 },
  ])
})

test('ttft is present only for a stream that produced one', () => {
  expect(buildRequestLog(fields())).not.toHaveProperty('ttft_ms')
  expect(buildRequestLog(fields({ stream: true, ttftMs: 310 }))).toMatchObject({ ttft_ms: 310 })
})

test.each([
  [200, 'ok', 'info'],
  [404, 'error', 'warn'],
  [429, 'error', 'warn'],
  [502, 'error', 'error'],
])('status %s logs at %s', (status, outcome, lvl) => {
  expect(buildRequestLog(fields({ status, outcome: outcome as never })).lvl).toBe(lvl)
})

test('an interrupted stream logs at error despite its 200', () => {
  // The status was committed with the first chunk, so it cannot report what
  // happened after it. That is the whole reason `outcome` exists.
  const line = buildRequestLog(fields({ status: 200, outcome: 'stream_interrupted' }))
  expect(line.lvl).toBe('error')
})

test('a client disconnect is not an error', () => {
  expect(buildRequestLog(fields({ status: 200, outcome: 'client_closed' })).lvl).toBe('info')
})

test('an unauthenticated request logs a null key rather than omitting it', () => {
  const line = buildRequestLog(fields({ key: null, model: null, status: 401, outcome: 'error' }))
  expect(line.key).toBeNull()
  expect(line.model).toBeNull()
})

test('the line carries only the fields it declares, so nothing leaks through from the input', () => {
  // buildRequestLog does not redact — it cannot, since it only ever sees a
  // key's name. What it can guarantee is that it never spreads its input,
  // which is the way anything sensitive would actually reach stdout.
  const line = buildRequestLog(fields())

  expect(Object.keys(line).sort()).toEqual([
    'attempts', 'key', 'latency_ms', 'lvl', 'model', 'msg',
    'outcome', 'request_id', 'status', 'stream',
  ])
})

test('emit writes exactly one line of JSON', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  emitRequestLog(fields())

  expect(log).toHaveBeenCalledTimes(1)
  const written = log.mock.calls[0][0] as string
  expect(written).not.toContain('\n')
  expect(JSON.parse(written).msg).toBe('gateway.request')
})

test('a failure to emit never escapes', () => {
  // A request that succeeded must not be turned into a failure by logging.
  const log = vi.spyOn(console, 'log').mockImplementation(() => {
    throw new Error('stdout is gone')
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(() => emitRequestLog(fields())).not.toThrow()
  expect(log).toHaveBeenCalled()
  expect(error).toHaveBeenCalled()
})

test('a failure to report the failure never escapes either', () => {
  // stdout and stderr are commonly the same pipe, so the fallback has to
  // survive whatever killed the primary sink.
  vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('stdout is gone') })
  vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('stderr too') })

  expect(() => emitRequestLog(fields())).not.toThrow()
})
