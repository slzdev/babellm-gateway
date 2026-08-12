'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  addManualModel, clearOverrideField, deleteCatalogModel, setOverride,
} from '@/lib/admin/catalog'
import { setCatalogSettings } from '@/lib/settings'
import { loadRegistry } from '@/lib/catalog/registry'
import { syncAllProviders } from '@/lib/catalog/sync'
import { modelKinds, type CatalogFields } from '@/lib/catalog/types'

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
  if (typeof kind === 'string' && kind !== '') {
    if (!(modelKinds as readonly string[]).includes(kind)) {
      throw new Error(`Unknown kind: ${kind}`)
    }
    patch.kind = kind as CatalogFields['kind']
  }

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

export async function clearOverrideAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await clearOverrideField(
      String(formData.get('id')),
      String(formData.get('field')) as keyof CatalogFields,
    )
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not clear the override.' }
  }
  revalidatePath('/catalog')
  return {}
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

export async function deleteCatalogModelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await deleteCatalogModel(String(formData.get('id')))
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not delete the model.' }
  }
  revalidatePath('/catalog')
  return { success: 'Model deleted.' }
}

export async function saveRegistrySettingsAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setCatalogSettings({
      // The Switch renders a native checkbox: checked submits "on" (no value
      // attribute is set, so it falls back to the HTML default) and unchecked
      // omits the field entirely. Treat anything present-and-not-explicitly-off
      // as true rather than betting on the exact string.
      registryEnabled: !['false', 'off', null, ''].includes(formData.get('registryEnabled') as string | null),
      registryUrl: String(formData.get('registryUrl') ?? ''),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the settings.' }
  }
  revalidatePath('/catalog')
  return { success: 'Registry settings saved.' }
}
