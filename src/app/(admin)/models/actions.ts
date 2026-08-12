'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import {
  addRouteTarget, createVirtualModel, deleteVirtualModel,
  removeRouteTarget, updateVirtualModel, type RoutingPolicy,
} from '@/lib/admin/models'

export interface ActionState {
  error?: string
  success?: string
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

export async function addTargetAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  try {
    await addRouteTarget({
      virtualModelId: String(formData.get('virtualModelId')),
      providerId: String(formData.get('providerId')),
      upstreamModel: String(formData.get('upstreamModel') ?? ''),
      priority: Number(formData.get('priority') ?? 0),
      weight: Number(formData.get('weight') ?? 100),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not add the target.' }
  }
  revalidatePath('/models')
  return { success: 'Target added.' }
}

export async function setPolicyAction(id: string, policy: RoutingPolicy): Promise<void> {
  await requireAdmin()
  await updateVirtualModel(id, { policy })
  revalidatePath('/models')
}

export async function removeTargetAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await removeRouteTarget(String(formData.get('id')))
  revalidatePath('/models')
}

export async function deleteModelAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteVirtualModel(String(formData.get('id')))
  revalidatePath('/models')
}
