'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  createProvider, deleteProvider, testProvider, updateProvider,
} from '@/lib/admin/providers'
import type { AdapterType } from '@/lib/adapters/credentials'

export interface ActionState {
  error?: string
  success?: string
}

function credentialsFrom(formData: FormData, adapter: AdapterType) {
  const entries: Record<string, unknown> = {}
  const fields =
    adapter === 'bedrock'
      ? ['region', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'useInstanceRole']
      : ['apiKey', 'organization', 'project']

  for (const field of fields) {
    const value = formData.get(field)
    if (field === 'useInstanceRole') {
      if (value === 'on') entries.useInstanceRole = true
      continue
    }
    if (typeof value === 'string' && value.length > 0) entries[field] = value
  }
  return entries
}

export async function createProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const adapter = String(formData.get('adapter')) as AdapterType

  try {
    await createProvider({
      name: String(formData.get('name') ?? ''),
      adapter,
      baseUrl: (formData.get('baseUrl') as string) || null,
      credentials: credentialsFrom(formData, adapter),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the provider.' }
  }

  revalidatePath('/providers')
  return { success: 'Provider created.' }
}

export async function toggleProviderAction(id: string, enabled: boolean): Promise<void> {
  await requireAdmin()
  await updateProvider(id, { enabled })
  revalidatePath('/providers')
}

export async function deleteProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await deleteProvider(String(formData.get('id')))
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not delete the provider.' }
  }
  revalidatePath('/providers')
  return { success: 'Provider deleted.' }
}

export async function testProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const result = await testProvider(
    String(formData.get('id')),
    String(formData.get('upstreamModel') ?? ''),
  )
  return result.ok ? { success: result.message } : { error: result.message }
}
