'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  addManualModel, clearOverrideField, deleteCatalogModel, setModelGateway, setOverride,
} from '@/lib/admin/catalog'
import { addRouteTarget, createVirtualModel } from '@/lib/admin/models'
import { setCatalogSettings } from '@/lib/settings'
import { loadRegistry } from '@/lib/catalog/registry'
import { syncAllProviders } from '@/lib/catalog/sync'
import { modelKinds, type CatalogFields } from '@/lib/catalog/types'
import type { ApiFlavor } from '@/lib/api-flavors'

export interface ActionState {
  error?: string
  success?: string
}

export interface SyncAllSummary {
  ok: number
  unsupported: number
  failed: number
}

export interface RegistryRefreshResult {
  status: string
  error: string | null
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

export async function syncAllAction(): Promise<SyncAllSummary> {
  await requireAdmin()
  const results = await syncAllProviders()
  revalidatePath('/catalog')
  revalidatePath('/providers')

  // `unsupported` (bedrock — no adapter until Phase 3) is a normal outcome,
  // not a failure, so it gets its own bucket rather than being folded into
  // `failed`.
  return {
    ok: results.filter((r) => r.status === 'ok').length,
    unsupported: results.filter((r) => r.status === 'unsupported').length,
    failed: results.filter((r) => r.status === 'failed').length,
  }
}

export async function refreshRegistryAction(): Promise<RegistryRefreshResult> {
  await requireAdmin()
  const result = await loadRegistry({ force: true })
  revalidatePath('/catalog')
  return { status: result.status, error: result.error }
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

/**
 * "(inherit)" submits an empty string, and NULL is what makes a model follow
 * its provider. Anything non-empty goes through unvalidated on purpose: the
 * admin layer owns the enum check, so there is one place that can reject an
 * unknown flavor.
 */
function apiFlavorValue(value: FormDataEntryValue | null): ApiFlavor | null {
  const flavor = String(value ?? '')
  return flavor === '' ? null : (flavor as ApiFlavor)
}

export async function setModelGatewayAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await setModelGateway(String(formData.get('id')), {
      apiFlavor: apiFlavorValue(formData.get('apiFlavor')),
      chatCompletionsPath: String(formData.get('chatCompletionsPath') ?? ''),
      responsesPath: String(formData.get('responsesPath') ?? ''),
      messagesPath: String(formData.get('messagesPath') ?? ''),
      embeddingsPath: String(formData.get('embeddingsPath') ?? ''),
    })
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Could not save the gateway settings.',
    }
  }
  revalidatePath('/catalog')
  return { success: 'Gateway settings saved.' }
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

export async function routeToModelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()

  const providerId = String(formData.get('providerId'))
  const upstreamModel = String(formData.get('modelId') ?? '')
  const existingId = String(formData.get('virtualModelId') ?? '')
  const newName = String(formData.get('newModelName') ?? '').trim()

  let virtualModelId = existingId
  // Tracked separately from existingId so the catch below can tell "the
  // model already existed" apart from "we just created it" — only the
  // latter needs the dropdown-refresh-and-reselect message.
  let createdName: string | null = null

  if (!virtualModelId) {
    if (!newName) return { error: 'Pick a virtual model, or name a new one.' }
    try {
      const created = await createVirtualModel({ name: newName })
      virtualModelId = created.id
      createdName = created.name
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Could not create the virtual model.' }
    }
  }

  try {
    await addRouteTarget({ virtualModelId, providerId, upstreamModel })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Could not create the route.'
    if (createdName) {
      // The virtual model was already created and is not rolled back — leave
      // it in place and revalidate so it shows up in the dropdown, then tell
      // the user to select it instead of retyping the name (which would now
      // collide).
      revalidatePath('/catalog')
      revalidatePath('/models')
      return {
        error: `Created virtual model "${createdName}", but could not add the route: ${reason} `
          + `Select "${createdName}" from the list above and try again.`,
      }
    }
    return { error: reason }
  }

  revalidatePath('/catalog')
  revalidatePath('/models')
  // The route just landed in this model's targets table, which the model's
  // own page renders.
  revalidatePath(`/models/${virtualModelId}`)
  return { success: 'Route created.' }
}
