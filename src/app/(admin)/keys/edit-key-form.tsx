'use client'

import { FormDialog } from '@/components/admin/form-dialog'
import type { ApiKeyListItem } from '@/lib/admin/keys'
import { updateKeyAction, type KeyActionState } from './actions'
import { KeyFields } from './key-fields'

export function EditKeyDialog({
  apiKey, users, open, onOpenChange,
}: {
  apiKey: ApiKeyListItem
  users: Array<{ id: string; name: string }>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <FormDialog<KeyActionState>
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${apiKey.name}`}
      description="The secret itself cannot be changed here — only its hash is stored. Rotate the key to issue a new one."
      action={updateKeyAction}
      submitLabel="Save"
      successMessage="Key updated."
    >
      <input type="hidden" name="id" value={apiKey.id} />
      <KeyFields users={users} values={apiKey} />
    </FormDialog>
  )
}
