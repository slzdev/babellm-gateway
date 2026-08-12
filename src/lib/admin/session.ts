import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

export const SESSION_COOKIE = 'babellm_session'
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

function secret(): string {
  const value = process.env.SESSION_SECRET
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters.')
  }
  return value
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function signSession(expiresAt: number): string {
  const payload = String(expiresAt)
  return `${payload}.${sign(payload)}`
}

export function verifySession(token: string | undefined): boolean {
  if (!token) return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false

  const expected = Buffer.from(sign(payload))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false

  const expiresAt = Number(payload)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies()
  return verifySession(store.get(SESSION_COOKIE)?.value)
}

export async function requireAdmin(): Promise<void> {
  if (!(await isAuthenticated())) redirect('/login')
}

export async function login(password: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) throw new Error('ADMIN_PASSWORD is not set.')

  const a = Buffer.from(password)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  const store = await cookies()
  store.set(SESSION_COOKIE, signSession(Date.now() + SESSION_TTL_MS), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
  return true
}

export async function logout(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}
