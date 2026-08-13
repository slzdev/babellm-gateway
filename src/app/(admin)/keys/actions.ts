'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  createApiKey, deleteApiKey, setApiKeyEnabled, setApiKeyLogPayloads,
} from '@/lib/admin/keys'

export interface CreateKeyState {
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

export async function createKeyAction(
  _prev: CreateKeyState | undefined,
  formData: FormData,
): Promise<CreateKeyState> {
  await requireAdmin()
  const expiresAtRaw = optionalText(formData, 'expiresAt')

  try {
    const { plaintextKey } = await createApiKey({
      name: String(formData.get('name') ?? ''),
      userId: optionalText(formData, 'userId'),
      rpmLimit: optionalInt(formData, 'rpmLimit'),
      tpmLimit: optionalInt(formData, 'tpmLimit'),
      budgetMonthlyUsd: optionalText(formData, 'budgetMonthlyUsd'),
      budgetTotalUsd: optionalText(formData, 'budgetTotalUsd'),
      expiresAt: expiresAtRaw ? new Date(expiresAtRaw) : null,
      // The Switch renders a native checkbox: checked submits "on" (no value
      // attribute is set, so it falls back to the HTML default) and unchecked
      // omits the field entirely. Treat anything present-and-not-explicitly-off
      // as true rather than betting on the exact string.
      logPayloads: !['false', 'off', null, ''].includes(formData.get('logPayloads') as string | null),
    })
    revalidatePath('/keys')
    return { plaintextKey }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the key.' }
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
