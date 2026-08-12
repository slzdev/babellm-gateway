'use client'

import { useState } from 'react'
import { MoreHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmAction } from '@/components/admin/confirm-action'
import { deleteUserAction } from './actions'

export function UserRowActions({ id, name }: { id: string; name: string }) {
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} />}
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Sibling of the menu, not a child: the menu closes on item click, and a
          dialog unmounting with its trigger would never open. */}
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${name}?`}
        description="Any API keys attributed to this user become unassigned. This cannot be undone."
        successMessage="User deleted."
        onConfirm={async () => {
          const formData = new FormData()
          formData.set('id', id)
          await deleteUserAction(formData)
        }}
      />
    </>
  )
}
