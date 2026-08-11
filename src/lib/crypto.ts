import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(
      'ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32',
    )
  }
  return Buffer.from(raw, 'hex')
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decryptJson<T>(blob: string): T {
  const [version, iv, tag, ciphertext] = blob.split('.')
  if (version !== VERSION) {
    throw new Error(`unsupported ciphertext version: ${version}`)
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8')) as T
}
