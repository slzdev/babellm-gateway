import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { apiKeys, type ApiKeyRow } from '@/lib/db/schema'
import { GatewayError } from './errors'

const KEY_PREFIX = 'sk-bab-'
const PREFIX_DISPLAY_LENGTH = 12

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function generateApiKey() {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url')
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, PREFIX_DISPLAY_LENGTH) }
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

function unauthorized(message: string, code: string): GatewayError {
  return new GatewayError({
    status: 401,
    type: 'invalid_request_error',
    code,
    message,
  })
}

export async function resolveApiKey(token: string | null): Promise<ApiKeyRow> {
  if (!token) {
    throw unauthorized(
      'No API key provided. Send it as: Authorization: Bearer <key>.',
      'missing_api_key',
    )
  }

  const [key] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(token)))
    .limit(1)

  if (!key) throw unauthorized('Incorrect API key provided.', 'invalid_api_key')
  if (!key.enabled) throw unauthorized('This API key has been disabled.', 'key_disabled')
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('This API key has expired.', 'key_expired')
  }

  return key
}

export async function touchApiKey(id: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id))
}
