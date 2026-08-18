import { expect, test, vi } from 'vitest'
import OpenAI from 'openai'
import { attemptContext, execute } from '@/lib/gateway/execute'
import { ProviderError, RoutedError, UnsupportedOperationError } from '@/lib/gateway/errors'
import type { ProviderAdapter } from '@/lib/adapters/types'
import type { Candidate } from '@/lib/gateway/resolve'
import type { ProviderRow } from '@/lib/db/schema'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '@/lib/timeouts'

function candidate(name: string): Candidate {
  return {
    targetId: `target-${name}`,
    provider: { id: `p-${name}`, name, config: '{}' } as ProviderRow,
    upstreamModel: `${name}-model`,
    priority: 0,
    weight: 100,
    serviceTier: null,
    apiFlavor: 'chat_completions',
    forceUpstreamStream: false,
    pathOverrides: null,
    maxOutputTokens: null,
    breakable: true,
    breakerThreshold: null,
    breakerCooldownSeconds: null,
  }
}

/** Every provider gets the same stub adapter; `run` decides what happens. */
const stubAdapter = {} as ProviderAdapter
const deps = { createAdapter: () => stubAdapter }
const live = new AbortController().signal

test('the first target that succeeds ends the loop', async () => {
  const run = vi.fn().mockResolvedValue('body')
  const result = await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)

  expect(result.value).toBe('body')
  expect(result.candidate.provider.name).toBe('a')
  expect(run).toHaveBeenCalledTimes(1)
  expect(result.attempts).toHaveLength(1)
  expect(result.attempts[0]).toMatchObject({ n: 1, provider: 'a', status: 200 })
})

test('a retryable failure advances to the next target', async () => {
  const run = vi.fn()
    .mockRejectedValueOnce(new ProviderError({ status: 503, message: 'down', retryable: true }))
    .mockResolvedValueOnce('body')

  const result = await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)

  expect(result.candidate.provider.name).toBe('b')
  expect(result.attempts.map((a) => a.provider)).toEqual(['a', 'b'])
  expect(result.attempts[0]).toMatchObject({ n: 1, status: 503 })
  expect(result.attempts[0].error).toContain('down')
  expect(result.attempts[1]).toMatchObject({ n: 2, status: 200 })
  expect(result.attempts[1].error).toBeUndefined()
})

test('a fatal failure stops immediately without trying the rest', async () => {
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 400, code: 'invalid_request', message: 'bad tools', retryable: false }),
  )

  await expect(execute([candidate('a'), candidate('b')], 'req_1', live, deps, run))
    .rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  expect(run).toHaveBeenCalledTimes(1)
})

test('an exhausted chain surfaces the last error, not a generic 502', async () => {
  const run = vi.fn()
    .mockRejectedValueOnce(new ProviderError({ status: 500, message: 'boom', retryable: true }))
    .mockRejectedValueOnce(new ProviderError({ status: 429, code: 'rate_limit_exceeded', message: 'slow down', retryable: true }))

  await expect(execute([candidate('a'), candidate('b')], 'req_1', live, deps, run))
    .rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded' })
})

test('the thrown error carries every attempt made', async () => {
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 500, message: 'boom', retryable: true }),
  )

  const err = await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)
    .catch((e: unknown) => e)

  expect(err).toBeInstanceOf(RoutedError)
  expect((err as RoutedError).attempts.map((a) => a.provider)).toEqual(['a', 'b'])
  expect((err as RoutedError).lastProvider).toBe('b')
})

test('a chain of one is not retried', async () => {
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 503, message: 'down', retryable: true }),
  )

  await expect(execute([candidate('a')], 'req_1', live, deps, run)).rejects.toThrow()
  expect(run).toHaveBeenCalledTimes(1)
})

test('a createAdapter failure skips that target instead of failing the request', async () => {
  // createAdapter throws UnsupportedOperationError for gemini and bedrock —
  // two of the four adapter types the provider form offers. Treating that as
  // fatal would let one unimplemented target break a model whose other
  // targets are perfectly healthy.
  const run = vi.fn().mockResolvedValue('body')
  const createAdapter = vi.fn()
    .mockImplementationOnce(() => { throw new UnsupportedOperationError('gemini is not available yet') })
    .mockImplementationOnce(() => stubAdapter)

  const result = await execute(
    [candidate('gem'), candidate('oai')], 'req_1', live, { createAdapter }, run,
  )

  expect(result.candidate.provider.name).toBe('oai')
  expect(result.attempts[0]).toMatchObject({ n: 1, provider: 'gem', status: 501 })
  expect(run).toHaveBeenCalledTimes(1)
})

test('a chain of only unconstructable targets surfaces the construction error', async () => {
  // The single-target gemini case, which tests/gateway/chat.test.ts pins as
  // a 501 rather than an opaque 500.
  const createAdapter = () => { throw new UnsupportedOperationError('gemini is not available yet') }

  await expect(
    execute([candidate('gem')], 'req_1', live, { createAdapter }, vi.fn()),
  ).rejects.toMatchObject({ status: 501, code: 'unsupported_operation' })
})

test('an unconstructable target late in the chain does not displace a real upstream error', async () => {
  // Chain order varies per request under weighted and round_robin, so a
  // gemini target sitting behind a rate-limited openai one must not turn a
  // 429 into a 501 that clients will never retry.
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 429, code: 'rate_limit_exceeded', message: 'slow down', retryable: true }),
  )
  const createAdapter = vi.fn()
    .mockImplementationOnce(() => stubAdapter)
    .mockImplementationOnce(() => { throw new UnsupportedOperationError('gemini is not available yet') })

  await expect(
    execute([candidate('oai'), candidate('gem')], 'req_1', live, { createAdapter }, run),
  ).rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded' })
})

test('an UnsupportedOperationError from the call itself is fatal', async () => {
  // Unlike construction, this one describes the *operation* — another
  // provider would only fail differently.
  const run = vi.fn().mockRejectedValue(
    new UnsupportedOperationError('embeddings are not supported by this provider'),
  )

  await expect(execute([candidate('a'), candidate('b')], 'req_1', live, deps, run))
    .rejects.toMatchObject({ status: 501 })
  expect(run).toHaveBeenCalledTimes(1)
})

test('a client disconnect stops the loop rather than failing over', async () => {
  const controller = new AbortController()
  const run = vi.fn().mockImplementation(async () => {
    controller.abort()
    throw new ProviderError({ status: 504, message: 'aborted', retryable: true })
  })

  await expect(
    execute([candidate('a'), candidate('b')], 'req_1', controller.signal, deps, run),
  ).rejects.toThrow()
  expect(run).toHaveBeenCalledTimes(1)
})

test('an unwrapped SDK error still classifies, via the gateway fallback', async () => {
  // Belt and braces for an adapter that forgets to wrap a call site.
  const run = vi.fn()
    .mockRejectedValueOnce(new OpenAI.APIError(500, { message: 'server error' }, 'server error', undefined))
    .mockResolvedValueOnce('body')

  const result = await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)
  expect(result.candidate.provider.name).toBe('b')
})

test('each attempt gets its own context carrying that target upstream model', async () => {
  const seen: string[] = []
  const run = vi.fn().mockImplementation(async (_adapter, ctx) => {
    seen.push(ctx.upstreamModel)
    if (seen.length === 1) throw new ProviderError({ status: 500, message: 'x', retryable: true })
    return 'body'
  })

  await execute([candidate('a'), candidate('b')], 'req_1', live, deps, run)
  expect(seen).toEqual(['a-model', 'b-model'])
})

test('attempts record a latency', async () => {
  const run = vi.fn().mockResolvedValue('body')
  const result = await execute([candidate('a')], 'req_1', live, deps, run)
  expect(result.attempts[0].latencyMs).toBeGreaterThanOrEqual(0)
})

/** Collects (targetId, outcome) pairs so a test can assert on the whole set
 *  of calls, including the ones that must not happen. */
function recorder() {
  const calls: Array<[string, string]> = []
  return {
    calls,
    recordHealth: (c: Candidate, outcome: 'success' | 'failure') => {
      calls.push([c.targetId, outcome])
    },
  }
}

test('a successful attempt is recorded as a success', async () => {
  const { calls, recordHealth } = recorder()
  await execute([candidate('a')], 'req_1', live, { ...deps, recordHealth }, async () => 'body')

  expect(calls).toEqual([['target-a', 'success']])
})

test('a retryable failure is recorded against the target that produced it', async () => {
  const { calls, recordHealth } = recorder()
  const run = vi.fn()
    .mockRejectedValueOnce(new ProviderError({ status: 503, message: 'down', retryable: true }))
    .mockResolvedValueOnce('body')

  await execute([candidate('a'), candidate('b')], 'req_1', live, { ...deps, recordHealth }, run)

  expect(calls).toEqual([['target-a', 'failure'], ['target-b', 'success']])
})

test('a client hanging up is not held against the target', async () => {
  // An AbortError classifies as a retryable 504. Counting it would open
  // breakers on healthy targets serving slow, cancellable generations.
  const { calls, recordHealth } = recorder()
  const controller = new AbortController()
  controller.abort()
  const run = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))

  await expect(
    execute([candidate('a')], 'req_1', controller.signal, { ...deps, recordHealth }, run),
  ).rejects.toThrow()

  expect(calls).toEqual([])
})

test('a non-retryable 4xx is recorded in neither direction', async () => {
  // The target answered, so it is not a failure; but clearing the counter
  // would let one bad client erase real accumulated evidence.
  const { calls, recordHealth } = recorder()
  const run = vi.fn().mockRejectedValue(
    new ProviderError({ status: 400, message: 'bad', retryable: false }),
  )

  await expect(
    execute([candidate('a')], 'req_1', live, { ...deps, recordHealth }, run),
  ).rejects.toThrow()

  expect(calls).toEqual([])
})

test('an unconstructable adapter is not recorded', async () => {
  // No upstream call was made, so there is nothing to protect.
  const { calls, recordHealth } = recorder()
  const createAdapter = () => { throw new UnsupportedOperationError('no adapter') }

  await expect(
    execute([candidate('a')], 'req_1', live, { createAdapter, recordHealth }, async () => 'body'),
  ).rejects.toThrow()

  expect(calls).toEqual([])
})

test('an unbreakable candidate is never recorded', async () => {
  const { calls, recordHealth } = recorder()
  const direct = { ...candidate('a'), breakable: false }

  await execute([direct], 'req_1', live, { ...deps, recordHealth }, async () => 'body')

  expect(calls).toEqual([])
})

test('execute passes the candidate ceiling to the adapter factory', async () => {
  const createAdapter = vi.fn().mockReturnValue(stubAdapter)
  const run = vi.fn().mockResolvedValue('body')
  const chain = [{ ...candidate('a'), maxOutputTokens: 64000 }]

  await execute(chain, 'req_1', live, { createAdapter }, run)

  expect(createAdapter).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      flavor: 'chat_completions', paths: null, maxOutputTokens: 64000, forceStream: false,
    }),
  )
})

test('execute passes the candidate forcing decision to the adapter factory', async () => {
  const createAdapter = vi.fn().mockReturnValue(stubAdapter)
  const run = vi.fn().mockResolvedValue('body')
  const chain = [{ ...candidate('a'), forceUpstreamStream: true }]

  await execute(chain, 'req_1', live, { createAdapter }, run)

  // The catalog model's tri-state override lives on the candidate, not on the
  // provider row — the provider column alone would not produce this.
  expect(createAdapter).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ forceStream: true }),
  )
})

// AbortSignal.timeout() schedules through Node's internal timer wheel, not
// the global setTimeout that vi.useFakeTimers() patches, so fake timers never
// observe it firing. Asserting the millisecond argument it was constructed
// with is the reliable way to pin the ceiling without an actual 30s wait.
test('an attempt times out after 30 seconds by default', () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

  attemptContext(candidate('oai'), 'req_1', new AbortController().signal)

  expect(timeoutSpy).toHaveBeenCalledWith(30_000)
  timeoutSpy.mockRestore()
})

test('config.timeoutMs overrides the default', () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
  const target = candidate('oai')
  target.provider = { ...target.provider, config: JSON.stringify({ timeoutMs: 600_000 }) }

  attemptContext(target, 'req_1', new AbortController().signal)

  expect(timeoutSpy).toHaveBeenCalledWith(600_000)
  timeoutSpy.mockRestore()
})

// config is a JSON blob an operator can edit in the database, past every
// validation the form does. An unusable value must not become a timeout that
// fires on the next tick and reports itself as a bare abort.
test.each([
  ['a string', '"soon"'],
  ['zero', '0'],
  ['a negative', '-1'],
  ['a fraction', '1500.5'],
  ['past the maximum', String(MAX_TIMEOUT_MS + 1)],
  ['null', 'null'],
])('a stored timeoutMs that is %s falls back to the default', (_label, raw) => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
  const target = candidate('oai')
  target.provider = { ...target.provider, config: `{"timeoutMs": ${raw}}` }

  attemptContext(target, 'req_1', new AbortController().signal)

  expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS)
  timeoutSpy.mockRestore()
})

test('the maximum itself is still honoured', () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
  const target = candidate('oai')
  target.provider = { ...target.provider, config: JSON.stringify({ timeoutMs: MAX_TIMEOUT_MS }) }

  attemptContext(target, 'req_1', new AbortController().signal)

  expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMEOUT_MS)
  timeoutSpy.mockRestore()
})
