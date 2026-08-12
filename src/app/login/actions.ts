'use server'

import { redirect } from 'next/navigation'
import { login } from '@/lib/admin/session'

export async function loginAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const password = String(formData.get('password') ?? '')
  if (!(await login(password))) return { error: 'Incorrect password.' }
  redirect('/providers')
}
