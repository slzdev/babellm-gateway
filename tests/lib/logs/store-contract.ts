import { describe, expect, test } from 'vitest'
import { uuidv7 } from '@/lib/uuid'
import type { LoggingSettings } from '@/lib/settings'
import type { ReadableRequestLogStore, RequestLogEntry } from '@/lib/logs/types'

const settings: LoggingSettings = {
  store: 'contract', retentionMonths: 3, payloadMaxBytes: 262_144,
}

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: uuidv7(), keyId: null, keyName: 'prod', model: 'house-model',
    stream: false, status: 200, outcome: 'ok', latencyMs: 10, attempts: [],
    ...overrides,
  }
}

/**
 * What every readable store must do identically.
 *
 * RequestLogStore is a union precisely so drivers can be swapped, and a
 * driver-specific test file cannot check that claim. Anything asserted here
 * is behaviour the admin UI relies on regardless of which store is
 * configured; anything genuinely driver-specific belongs in that driver's own
 * file.
 *
 * Resetting is the caller's job, not this suite's. Both driver test files
 * already carry a top-level `beforeEach` that resets their store, and a
 * top-level hook applies to nested describes too — so owning reset here would
 * run it twice per test. That is merely wasteful for a Postgres TRUNCATE and
 * genuinely slow for a DynamoDB table drop-and-recreate.
 */
export function storeContract(
  name: string,
  store: () => ReadableRequestLogStore,
): void {
  describe(`${name} store contract`, () => {
    test('a written entry comes back from query under the id it was given', async () => {
      const id = uuidv7()
      await store().write(entry({ id, model: 'house-model' }), settings)

      const page = await store().query({ limit: 10 })
      expect(page.rows).toHaveLength(1)
      expect(page.rows[0]).toMatchObject({ id, model: 'house-model', status: 200 })
    })

    test('get returns the attempt chain and the payload', async () => {
      const id = uuidv7()
      await store().write(entry({
        id,
        attempts: [
          { n: 1, targetId: 't1', provider: 'primary', model: 'm1', status: 503, latencyMs: 5, error: 'down' },
          { n: 2, targetId: 't2', provider: 'backup', model: 'm2', status: 200, latencyMs: 8 },
        ],
        payload: { request: { model: 'house-model' }, response: { ok: true }, truncated: false },
      }), settings)

      const detail = await store().get(id)
      expect(detail?.attempts).toHaveLength(2)
      expect(detail?.attempts[0].error).toBe('down')
      expect(detail?.payloadCaptured).toBe(true)
      expect(detail?.payload?.request).toEqual({ model: 'house-model' })
      expect(detail?.payload?.truncated).toBe(false)
    })

    test('get returns null for an unknown id', async () => {
      expect(await store().get(uuidv7())).toBeNull()
    })

    test('get returns null rather than throwing for a malformed id', async () => {
      expect(await store().get('not-a-uuid')).toBeNull()
      expect(await store().get('')).toBeNull()
      expect(await store().get("'; DROP TABLE request_logs; --")).toBeNull()
    })

    test('absent optional fields read back as null, never undefined', async () => {
      const id = uuidv7()
      await store().write(entry({ id }), settings)

      const detail = await store().get(id)
      expect(detail?.errorType).toBeNull()
      expect(detail?.ttftMs).toBeNull()
      expect(detail?.pricing).toBeNull()
      expect(detail?.droppedParams).toBeNull()
      expect(detail?.payload).toBeNull()
      expect(detail?.attempts).toEqual([])
    })

    test('rows come back newest first', async () => {
      const ids = Array.from({ length: 5 }, () => uuidv7())
      for (const id of ids) await store().write(entry({ id }), settings)

      const page = await store().query({ limit: 10 })
      expect(page.rows.map((r) => r.id)).toEqual([...ids].reverse())
    })

    test('a full page offers a next cursor and no previous one', async () => {
      for (let n = 0; n < 5; n += 1) await store().write(entry(), settings)

      const page = await store().query({ limit: 3 })
      expect(page.rows).toHaveLength(3)
      expect(page.nextCursor).toBe(page.rows[2].id)
      expect(page.prevCursor).toBeNull()
    })

    test('paging forward then back lands on the original rows', async () => {
      for (let n = 0; n < 9; n += 1) await store().write(entry(), settings)

      const first = await store().query({ limit: 3 })
      const second = await store().query({ limit: 3, after: first.nextCursor! })
      const back = await store().query({ limit: 3, before: second.prevCursor! })

      expect(second.rows.map((r) => r.id)).not.toEqual(first.rows.map((r) => r.id))
      expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id))
    })

    test('the last page reports no next cursor', async () => {
      for (let n = 0; n < 3; n += 1) await store().write(entry(), settings)

      const page = await store().query({ limit: 10 })
      expect(page.nextCursor).toBeNull()
    })

    test('filters narrow the page the same way on every store', async () => {
      await store().write(entry({ model: 'alpha', status: 200 }), settings)
      await store().write(entry({ model: 'beta', status: 500, outcome: 'error' }), settings)
      await store().write(entry({ model: 'alpha', status: 404 }), settings)

      expect((await store().query({ limit: 10, model: 'alpha' })).rows).toHaveLength(2)
      expect((await store().query({ limit: 10, statusClass: 'success' })).rows).toHaveLength(1)
      expect((await store().query({ limit: 10, statusClass: 'client_error' })).rows).toHaveLength(1)
      expect((await store().query({ limit: 10, statusClass: 'server_error' })).rows).toHaveLength(1)
      expect((await store().query({ limit: 10, outcome: 'error' })).rows).toHaveLength(1)
    })

    test('a time range selects on the id, which carries the clock', async () => {
      // Relative to the moment the suite runs, not hardcoded calendar dates:
      // Postgres only ever has partitions for the current month plus a few
      // ahead (there is no DEFAULT partition to catch a write outside that
      // window — see partitions.ts), so an absolute "old" date risks landing
      // in a month resetDb() never provisioned. Both ids below stay within
      // the current month while still exercising the id-carries-the-clock
      // filter.
      const now = new Date()
      const old = uuidv7(new Date(now.getTime() - 60 * 60 * 1000))
      const recent = uuidv7(now)
      await store().write(entry({ id: old }), settings)
      await store().write(entry({ id: recent }), settings)

      const page = await store().query({ limit: 10, from: new Date(now.getTime() - 30 * 60 * 1000) })
      expect(page.rows.map((r) => r.id)).toEqual([recent])
    })

    test('an empty store returns an empty page with no cursors', async () => {
      const page = await store().query({ limit: 10 })
      expect(page.rows).toEqual([])
      expect(page.nextCursor).toBeNull()
      expect(page.prevCursor).toBeNull()
    })
  })
}
