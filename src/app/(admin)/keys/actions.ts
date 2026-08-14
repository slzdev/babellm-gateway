'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  createApiKey, deleteApiKey, resetApiKeyUsage, rotateApiKey, setApiKeyEnabled,
  setApiKeyLogPayloads, updateApiKey, type ApiKeyInput,
} from '@/lib/admin/keys'

export interface CreateKeyState {
  error?: string
  plaintextKey?: string
}

export interface KeyActionState {
  error?: string
  success?: string
}

/** What rotation hands back: the new secret, shown once and never again. */
export interface RotateKeyResult {
  error?: string
  plaintextKey?: string
}

function optionalInt(formData: FormData, field: string): number | null {
  const value = formData.get(field)
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : null
}

function optionalText(formData: FormData, field: string): string | null {
  const value = formData.get(field)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The Switch renders a native checkbox: checked submits "on" (no value
 * attribute is set, so it falls back to the HTML default) and unchecked omits
 * the field entirely. Treat anything present-and-not-explicitly-off as true
 * rather than betting on the exact string.
 */
function checkbox(formData: FormData, field: string): boolean {
  return !['false', 'off', null, ''].includes(formData.get(field) as string | null)
}

/** The settings both the create and the edit form post, read the same way. */
function keyInputFrom(formData: FormData): ApiKeyInput {
  const expiresAt = optionalText(formData, 'expiresAt')
  return {
    name: String(formData.get('name') ?? ''),
    userId: optionalText(formData, 'userId'),
    rpmLimit: optionalInt(formData, 'rpmLimit'),
    tpmLimit: optionalInt(formData, 'tpmLimit'),
    budgetMonthlyUsd: optionalText(formData, 'budgetMonthlyUsd'),
    budgetTotalUsd: optionalText(formData, 'budgetTotalUsd'),
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    logPayloads: checkbox(formData, 'logPayloads'),
  }
}

export async function createKeyAction(
  _prev: CreateKeyState | undefined,
  formData: FormData,
): Promise<CreateKeyState> {
  await requireAdmin()

  try {
    const { plaintextKey } = await createApiKey(keyInputFrom(formData))
    revalidatePath('/keys')
    return { plaintextKey }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the key.' }
  }
}

export async function updateKeyAction(
  _prev: KeyActionState | undefined,
  formData: FormData,
): Promise<KeyActionState> {
  await requireAdmin()

  try {
    await updateApiKey(String(formData.get('id')), keyInputFrom(formData))
    revalidatePath('/keys')
    return {}
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the key.' }
  }
}

export async function rotateKeyAction(formData: FormData): Promise<RotateKeyResult> {
  await requireAdmin()

  try {
    const { plaintextKey } = await rotateApiKey(String(formData.get('id')))
    revalidatePath('/keys')
    return { plaintextKey }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not rotate the key.' }
  }
}

export async function resetKeyUsageAction(formData: FormData): Promise<KeyActionState> {
  await requireAdmin()

  try {
    const cleared = await resetApiKeyUsage(String(formData.get('id')))
    revalidatePath('/keys')
    // A counter store that is down leaves the counters exactly where they
    // were, so this reports the outage rather than a reset that never ran.
    return cleared
      ? { success: 'Usage counters reset.' }
      : { error: 'The usage counter store is unavailable — the counters were not reset.' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not reset the counters.' }
  }
}

export async function revokeKeyAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await setApiKeyEnabled(String(formData.get('id')), formData.get('enabled') === 'true')
  revalidatePath('/keys')
}

export async function setKeyPayloadLoggingAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await setApiKeyLogPayloads(String(formData.get('id')), formData.get('logPayloads') === 'true')
  revalidatePath('/keys')
}

export async function deleteKeyAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteApiKey(String(formData.get('id')))
  revalidatePath('/keys')
}
