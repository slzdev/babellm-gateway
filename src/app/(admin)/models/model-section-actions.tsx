'use client'

import { useState } from 'react'
import { MoreHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmAction } from '@/components/admin/confirm-action'
import { deleteModelAction } from './actions'

export function ModelSectionActions({ id, name }: { id: string; name: string }) {
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
            Delete model
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${name}?`}
        description="Requests to this virtual model start failing with 503. This cannot be undone."
        successMessage="Virtual model deleted."
        onConfirm={async () => {
          const formData = new FormData()
          formData.set('id', id)
          await deleteModelAction(formData)
        }}
      />
    </>
  )
}
