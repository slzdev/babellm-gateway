'use client'

import { useActionState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { testProviderAction, type ActionState } from './actions'

export function TestProviderButton({ providerId }: { providerId: string }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    testProviderAction, undefined,
  )

  useEffect(() => {
    if (state?.error) toast.error(state.error)
    if (state?.success) toast.success(state.success)
  }, [state])

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={providerId} />
      <Input name="upstreamModel" placeholder="gpt-4o-mini" required className="h-8 w-40" />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? 'Testing…' : 'Test'}
      </Button>
    </form>
  )
}
