'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FormDialog } from '@/components/admin/form-dialog'
import { createUserAction, type CreateUserState } from './actions'

export function CreateUserDialog() {
  return (
    <FormDialog<CreateUserState>
      trigger={<Button>Add user</Button>}
      title="Add a user"
      description="Users are labels for attributing API keys. They do not sign in."
      action={createUserAction}
      submitLabel="Add user"
      pendingLabel="Adding…"
      successMessage="User created."
    >
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Input id="notes" name="notes" />
      </div>
    </FormDialog>
  )
}
