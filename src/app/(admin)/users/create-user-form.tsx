'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createUserAction, type CreateUserState } from './actions'

export function CreateUserForm() {
  const [state, action, pending] = useActionState<CreateUserState | undefined, FormData>(
    createUserAction, undefined,
  )

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap items-end gap-2 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="notes">Notes</Label>
          <Input id="notes" name="notes" />
        </div>
        <Button type="submit" disabled={pending}>{pending ? 'Adding…' : 'Add user'}</Button>
      </form>

      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
    </div>
  )
}
