'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  createProvider, deleteProvider, getProviderConfig, testProvider, updateProvider,
} from '@/lib/admin/providers'
import { adapterTypes, type AdapterType } from '@/lib/adapters/credentials'
import { apiFlavors, type ApiFlavor } from '@/lib/adapters/types'
import { parseRegistryNamespace } from '@/lib/catalog/config'
import { syncProvider, type SyncResult } from '@/lib/catalog/sync'

export interface ActionState {
  error?: string
  success?: string
  // A save can succeed while the re-sync it triggers fails (e.g. a rotated key
  // is still bad). That is not a save failure, so it gets its own field rather
  // than overloading `error`.
  warning?: string
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

/**
 * The flavor field is only rendered for OpenAI-shaped adapters, so an absent
 * value means "not applicable" rather than "cleared" — createProvider defaults
 * it and updateProvider keeps whatever is stored.
 */
function apiFlavorFrom(formData: FormData): ApiFlavor | undefined {
  const value = formData.get('apiFlavor')
  if (typeof value !== 'string') return undefined
  return (apiFlavors as readonly string[]).includes(value)
    ? (value as ApiFlavor)
    : undefined
}

export async function createProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const rawAdapter = String(formData.get('adapter'))
  if (!(adapterTypes as readonly string[]).includes(rawAdapter)) {
    return { error: `Unknown adapter: ${rawAdapter}` }
  }
  const adapter = rawAdapter as AdapterType

  let namespace: string | null
  try {
    namespace = parseRegistryNamespace(String(formData.get('registryNamespace') ?? ''))
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid registry namespace.' }
  }

  let created
  try {
    created = await createProvider({
      name: String(formData.get('name') ?? ''),
      adapter,
      baseUrl: (formData.get('baseUrl') as string) || null,
      credentials: credentialsFrom(formData, adapter),
      // Set at create time so the sync this action fires can already enrich.
      config: namespace ? { registryNamespace: namespace } : {},
      apiFlavor: apiFlavorFrom(formData),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the provider.' }
  }

  revalidatePath('/providers')
  revalidatePath('/catalog')

  // The provider above has already been created — a sync failure (e.g. a
  // freshly typed key that turns out to be bad) must not roll that back or be
  // reported as a create failure. It is surfaced as a separate warning
  // instead, mirroring updateProviderAction's re-sync-after-save pattern.
  try {
    const result = await syncProvider(created.id)
    if (result.status === 'failed') {
      return {
        success: 'Provider created.',
        warning: `Sync failed: ${result.error ?? 'unknown error'}`,
      }
    }
  } catch (err) {
    return {
      success: 'Provider created.',
      warning: `Sync failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    }
  }

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

export async function syncProviderAction(id: string): Promise<SyncResult> {
  await requireAdmin()
  const result = await syncProvider(id)
  revalidatePath('/providers')
  revalidatePath('/catalog')
  return result
}

export async function updateProviderAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const id = String(formData.get('id'))
  const rawAdapter = String(formData.get('adapter'))
  if (!(adapterTypes as readonly string[]).includes(rawAdapter)) {
    return { error: `Unknown adapter: ${rawAdapter}` }
  }
  const adapter = rawAdapter as AdapterType

  const credentials = credentialsFrom(formData, adapter)

  try {
    const namespace = parseRegistryNamespace(String(formData.get('registryNamespace') ?? ''))

    // registryNamespace is the only config key this form edits. Merge it onto
    // the stored config instead of replacing the object outright — {} is
    // truthy, so passing it unconditionally would clobber keys no form
    // exposes yet (timeoutMs, disableStreamUsage) that are still read on the
    // request path.
    const config = await getProviderConfig(id)
    if (namespace) config.registryNamespace = namespace
    else delete config.registryNamespace

    await updateProvider(id, {
      name: String(formData.get('name') ?? ''),
      adapter,
      baseUrl: (formData.get('baseUrl') as string) || null,
      // An empty credential form means "keep what is stored" — the browser is
      // never sent the current secret, so a blank field cannot mean "erase".
      ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
      config,
      apiFlavor: apiFlavorFrom(formData),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not update the provider.' }
  }

  revalidatePath('/providers')
  revalidatePath('/catalog')

  // The save above has already succeeded — a re-sync failure (e.g. the rotated
  // key is still rejected) must not roll it back or be reported as a save
  // failure. It is surfaced as a separate warning instead.
  try {
    const result = await syncProvider(id)
    if (result.status === 'failed') {
      return {
        success: 'Provider updated.',
        warning: `Re-sync failed: ${result.error ?? 'unknown error'}`,
      }
    }
  } catch (err) {
    return {
      success: 'Provider updated.',
      warning: `Re-sync failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    }
  }

  return { success: 'Provider updated.' }
}
