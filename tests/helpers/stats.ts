import { db } from '@/lib/db'
import { requestLogs } from '@/lib/db/schema'
import { uuidv7 } from '@/lib/uuid'

type LogOverrides = Partial<typeof requestLogs.$inferInsert> & { at?: Date }

/**
 * Inserts one request_logs row with sane defaults.
 *
 * `at` sets the request's *start*, which is the uuid v7 id and therefore the
 * bucket the rollup files it under — deliberately independent of created_at,
 * so a test can insert a row "late" the way a long stream really does.
 */
export async function insertLog({ at, ...overrides }: LogOverrides = {}): Promise<string> {
  const id = overrides.id ?? uuidv7(at ?? new Date())
  await db.insert(requestLogs).values({
    id,
    model: 'gpt-5',
    stream: false,
    status: 200,
    outcome: 'ok',
    latencyMs: 500,
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 0,
    reasoningTokens: 0,
    inputCostUsd: '0.000100000',
    cachedCostUsd: '0',
    outputCostUsd: '0.000200000',
    costUsd: '0.000300000',
    finalProvider: 'openai',
    ...overrides,
  })
  return id
}
