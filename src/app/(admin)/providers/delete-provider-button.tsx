'use client'

import { useActionState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { deleteProviderAction, type ActionState } from './actions'

export function DeleteProviderButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    deleteProviderAction,
    undefined,
  )

  useEffect(() => {
    if (state?.error) toast.error(state.error)
    if (state?.success) toast.success(state.success)
  }, [state])

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? 'Deleting…' : 'Delete'}
      </Button>
    </form>
  )
}
