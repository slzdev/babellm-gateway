'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import { createUser, deleteUser } from '@/lib/admin/keys'

export interface CreateUserState {
  error?: string
}

export async function createUserAction(
  _prev: CreateUserState | undefined,
  formData: FormData,
): Promise<CreateUserState> {
  await requireAdmin()
  try {
    await createUser({
      name: String(formData.get('name') ?? ''),
      email: (formData.get('email') as string) || null,
      notes: (formData.get('notes') as string) || null,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the user.' }
  }
  revalidatePath('/users')
  return {}
}

export async function deleteUserAction(formData: FormData): Promise<void> {
  await requireAdmin()
  await deleteUser(String(formData.get('id')))
  revalidatePath('/users')
  revalidatePath('/keys')
}
