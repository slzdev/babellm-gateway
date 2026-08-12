'use client'

import { useState } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import type { PickerGroup, PickerModel } from '@/lib/admin/catalog'

function detail(model: PickerModel) {
  const parts: string[] = []
  if (model.contextWindow !== null) {
    parts.push(model.contextWindow >= 1000
      ? `${Math.round(model.contextWindow / 1000)}k`
      : String(model.contextWindow))
  }
  if (model.inputPerMtok !== null && model.outputPerMtok !== null) {
    parts.push(`$${model.inputPerMtok.toFixed(2)}/$${model.outputPerMtok.toFixed(2)}`)
  }
  if (model.status === 'missing') parts.push('missing upstream')
  return parts.join(' · ')
}

/**
 * A combobox, not a select: anything typed is saveable. The catalog is
 * advisory, so an unrecognised value warns rather than blocking.
 *
 * `name`/`id`/`required` live on `Autocomplete.Root`, not `Autocomplete.Input`
 * — the installed API (selectionMode 'none', which is what Autocomplete always
 * uses) has the visible input "own" the form value, and Root forwards its
 * `name` onto that input internally. Setting `name` directly on `Input` isn't
 * part of the documented contract, so the typed-value-always-submits
 * guarantee is wired through Root.
 */
export function ModelCombobox({
  name,
  id,
  groups,
  defaultValue = '',
}: {
  name: string
  id: string
  groups: PickerGroup[]
  defaultValue?: string
}) {
  const [value, setValue] = useState(defaultValue)

  const known = new Set(groups.flatMap((g) => g.items.map((i) => i.modelId)))
  const unrecognised = value.trim().length > 0 && !known.has(value.trim())

  return (
    <div className="space-y-1">
      <Autocomplete.Root
        id={id}
        name={name}
        items={groups}
        value={value}
        onValueChange={setValue}
        itemToStringValue={(item: PickerModel) => item.modelId}
      >
        <Autocomplete.Input
          required
          placeholder="gpt-4o-mini"
          className="h-9 w-56 rounded-md border bg-transparent px-3 text-sm"
        />

        <Autocomplete.Portal>
          <Autocomplete.Positioner sideOffset={4} className="outline-hidden">
            <Autocomplete.Popup className="max-h-80 w-(--anchor-width) overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
              <Autocomplete.Empty className="px-2 py-3 text-sm text-muted-foreground">
                Nothing in the catalog matches — you can still type any model name.
              </Autocomplete.Empty>

              <Autocomplete.List>
                {(group: PickerGroup) => (
                  <Autocomplete.Group key={group.value} items={group.items} className="block pb-1">
                    <Autocomplete.GroupLabel className="px-2 py-1 text-xs text-muted-foreground select-none">
                      {group.value}
                    </Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(model: PickerModel) => (
                        <Autocomplete.Item
                          key={model.id}
                          value={model}
                          className="flex cursor-default items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                        >
                          <span className="font-mono text-xs">{model.modelId}</span>
                          <span className="text-xs text-muted-foreground">{detail(model)}</span>
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>

      {unrecognised ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Not in the catalog — saving anyway is fine.
        </p>
      ) : null}
    </div>
  )
}
