'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createKeyAction, type CreateKeyState } from './actions'

export function CreateKeyForm({ users }: { users: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState<CreateKeyState | undefined, FormData>(
    createKeyAction, undefined,
  )

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">Create an API key</h2>

      <form action={action} className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="production app" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="userId">User</Label>
          <select id="userId" name="userId" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm">
            <option value="">Unassigned</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="expiresAt">Expires</Label>
          <Input id="expiresAt" name="expiresAt" type="date" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rpmLimit">Requests / min</Label>
          <Input id="rpmLimit" name="rpmLimit" type="number" min={1} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tpmLimit">Tokens / min</Label>
          <Input id="tpmLimit" name="tpmLimit" type="number" min={1} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="budgetMonthlyUsd">Monthly budget (USD)</Label>
          <Input id="budgetMonthlyUsd" name="budgetMonthlyUsd" type="number" step="0.01" min={0} />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create key'}</Button>
        </div>
      </form>

      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}

      {state?.plaintextKey ? (
        <div className="space-y-1 rounded-md border border-dashed p-3">
          <p className="text-sm font-medium">Copy this key now — it is never shown again.</p>
          <code className="block break-all font-mono text-sm">{state.plaintextKey}</code>
        </div>
      ) : null}
    </div>
  )
}
