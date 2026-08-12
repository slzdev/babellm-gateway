'use client'

import { useState } from 'react'
import { MoreHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmAction } from '@/components/admin/confirm-action'
import type { CatalogListItem } from '@/lib/admin/catalog'
import { deleteCatalogModelAction } from './actions'
import { OverrideDialog, RouteToModelDialog } from './catalog-forms'

export function CatalogRowActions({
  item, virtualModels,
}: {
  item: CatalogListItem
  virtualModels: Array<{ id: string; name: string }>
}) {
  const [overriding, setOverriding] = useState(false)
  const [routing, setRouting] = useState(false)
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${item.modelId}`} />}
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setOverriding(true)}>Edit overrides</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRouting(true)}>
            Route to a virtual model
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <OverrideDialog item={item} open={overriding} onOpenChange={setOverriding} />
      <RouteToModelDialog
        item={item}
        virtualModels={virtualModels}
        open={routing}
        onOpenChange={setRouting}
      />
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${item.modelId} from the catalog?`}
        description={
          item.routeTargetCount > 0
            ? `${item.routeTargetCount} route target(s) still point here. Deleting does not remove them.`
            : 'A later sync will re-add it if the provider still serves it.'
        }
        successMessage="Model deleted."
        onConfirm={async () => {
          const formData = new FormData()
          formData.set('id', item.id)
          return deleteCatalogModelAction(undefined, formData)
        }}
      />
    </>
  )
}
