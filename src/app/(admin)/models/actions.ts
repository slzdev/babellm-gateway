'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  addRouteTarget, createVirtualModel, deleteVirtualModel,
  removeRouteTarget, setRouteTargetEnabled, updateRouteTarget, updateVirtualModel,
  type RoutingPolicy, type ServiceTier,
} from '@/lib/admin/models'

export interface ActionState {
  error?: string
  success?: string
}

/**
 * A model's targets are summarised on the list and edited on its detail page,
 * so every mutation has to refresh both. The detail path is revalidated as a
 * literal `/models/<id>` rather than as the `/models/[id]` pattern — which is
 * why the target actions carry a model id they otherwise have no use for.
 */
function revalidateModel(virtualModelId: string) {
  revalidatePath('/models')
  revalidatePath(`/models/${virtualModelId}`)
}

/**
 * The Switch renders a native checkbox: checked submits "on" (no value
 * attribute is set, so it falls back to the HTML default) and unchecked omits
 * the field entirely. Treat anything present-and-not-explicitly-off as true
 * rather than betting on the exact string.
 */
function checkboxValue(value: FormDataEntryValue | null): boolean {
  return !['false', 'off', null, ''].includes(value as string | null)
}

/**
 * The tier select submits an empty string for "(none)", which has to reach the
 * column as NULL — that is what makes the gateway leave the request alone.
 * Anything non-empty goes through unvalidated on purpose: the admin layer owns
 * the enum check, so there is one place that can reject an unknown tier.
 */
function serviceTierValue(value: FormDataEntryValue | null): ServiceTier | null {
  const tier = String(value ?? '')
  return tier === '' ? null : (tier as ServiceTier)
}

export async function createModelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await createVirtualModel({
      name: String(formData.get('name') ?? ''),
      description: (formData.get('description') as string) || null,
      policy: String(formData.get('policy') ?? 'failover') as RoutingPolicy,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the model.' }
  }
  revalidatePath('/models')
  return { success: 'Virtual model created.' }
}

export async function updateModelAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const id = String(formData.get('id'))
  try {
    await updateVirtualModel(id, {
      name: String(formData.get('name') ?? ''),
      description: (formData.get('description') as string) || null,
      policy: String(formData.get('policy') ?? 'failover') as RoutingPolicy,
      maxAttempts: Number(formData.get('maxAttempts')),
      enabled: checkboxValue(formData.get('enabled')),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the model.' }
  }
  revalidateModel(id)
  return { success: 'Virtual model saved.' }
}

export async function addTargetAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const virtualModelId = String(formData.get('virtualModelId'))
  try {
    await addRouteTarget({
      virtualModelId,
      providerId: String(formData.get('providerId')),
      upstreamModel: String(formData.get('upstreamModel') ?? ''),
      priority: Number(formData.get('priority') ?? 0),
      weight: Number(formData.get('weight') ?? 100),
      serviceTier: serviceTierValue(formData.get('serviceTier')),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not add the target.' }
  }
  revalidateModel(virtualModelId)
  return { success: 'Target added.' }
}

export async function updateTargetAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await updateRouteTarget(String(formData.get('id')), {
      upstreamModel: String(formData.get('upstreamModel') ?? ''),
      priority: Number(formData.get('priority') ?? 0),
      weight: Number(formData.get('weight') ?? 100),
      serviceTier: serviceTierValue(formData.get('serviceTier')),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not update the target.' }
  }
  revalidateModel(String(formData.get('virtualModelId')))
  return { success: 'Target updated.' }
}

export async function toggleTargetAction(
  id: string,
  enabled: boolean,
  virtualModelId: string,
): Promise<void> {
  await requireAdmin()
  await setRouteTargetEnabled(id, enabled)
  revalidateModel(virtualModelId)
}

export async function removeTargetAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await removeRouteTarget(String(formData.get('id')))
  revalidateModel(String(formData.get('virtualModelId')))
}

export async function deleteModelAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteVirtualModel(String(formData.get('id')))
  // No detail path to revalidate: the page it was rendering is gone, and the
  // caller navigates back to the list.
  revalidatePath('/models')
}
