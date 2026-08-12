'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  addManualModel, clearOverrideField, deleteCatalogModel, setOverride,
} from '@/lib/admin/catalog'
import { setCatalogSettings } from '@/lib/settings'
import { loadRegistry } from '@/lib/catalog/registry'
import { syncAllProviders } from '@/lib/catalog/sync'
import type { CatalogFields } from '@/lib/catalog/types'

export interface ActionState {
  error?: string
  success?: string
}

/** Numeric override fields, parsed from their form values. */
const NUMERIC_FIELDS = [
  'contextWindow', 'maxOutputTokens', 'inputPerMtok', 'outputPerMtok',
  'cachedInputPerMtok',
] as const satisfies readonly (keyof CatalogFields)[]

function overrideFrom(formData: FormData): Partial<CatalogFields> {
  const patch: Partial<CatalogFields> = {}

  for (const field of NUMERIC_FIELDS) {
    const raw = formData.get(field)
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a non-negative number.`)
    }
    patch[field] = value
  }

  for (const field of ['supportsTools', 'supportsStreaming'] as const) {
    const raw = formData.get(field)
    if (raw === 'true') patch[field] = true
    else if (raw === 'false') patch[field] = false
  }

  const kind = formData.get('kind')
  if (typeof kind === 'string' && kind !== '') patch.kind = kind as CatalogFields['kind']

  return patch
}

export async function syncAllAction(): Promise<void> {
  await requireAdmin()
  await syncAllProviders()
  revalidatePath('/catalog')
  revalidatePath('/providers')
}

export async function refreshRegistryAction(): Promise<void> {
  await requireAdmin()
  await loadRegistry({ force: true })
  revalidatePath('/catalog')
}

export async function setOverrideAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setOverride(String(formData.get('id')), overrideFrom(formData))
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the override.' }
  }
  revalidatePath('/catalog')
  return { success: 'Override saved.' }
}

export async function clearOverrideAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await clearOverrideField(
    String(formData.get('id')),
    String(formData.get('field')) as keyof CatalogFields,
  )
  revalidatePath('/catalog')
}

export async function addManualModelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await addManualModel({
      providerId: String(formData.get('providerId')),
      modelId: String(formData.get('modelId') ?? ''),
      fields: overrideFrom(formData),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not add the model.' }
  }
  revalidatePath('/catalog')
  return { success: 'Model added.' }
}

export async function deleteCatalogModelAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteCatalogModel(String(formData.get('id')))
  revalidatePath('/catalog')
}

export async function saveRegistrySettingsAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setCatalogSettings({
      registryEnabled: formData.get('registryEnabled') === 'on',
      registryUrl: String(formData.get('registryUrl') ?? ''),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the settings.' }
  }
  revalidatePath('/catalog')
  return { success: 'Registry settings saved.' }
}
