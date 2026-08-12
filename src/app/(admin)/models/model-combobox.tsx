'use client'

import { useState } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import {
  ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput,
  ComboboxItem, ComboboxLabel, ComboboxList,
} from '@/components/ui/combobox'
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
 * advisory — a provider that has never synced offers nothing at all — so an
 * unrecognised value warns rather than blocking.
 *
 * That free-text guarantee is why the root here is `Autocomplete.Root` while
 * every other part comes from the shadcn combobox. In Base UI 1.7 the two are
 * one component: `Autocomplete.Root` is the combobox root pinned to
 * `selectionMode: 'none'`, and Item/Trigger/Input/Popup/List/Group are the
 * very same exports under both names. Under `selectionMode: 'none'` the
 * visible input owns the form value, so what the admin typed is what submits;
 * the shadcn `Combobox` root would submit only a value picked from the list.
 *
 * `name`/`required` therefore live on the root, not on `ComboboxInput` — the
 * root forwards `name` onto that input internally, and setting it directly on
 * the input isn't part of the documented contract.
 *
 * The list filters on what is typed, including a value restored from a saved
 * target — clearing the field (the ✕ the input grows once it has a value) is
 * what brings the whole catalog back into view.
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
        name={name}
        required
        items={groups}
        value={value}
        onValueChange={setValue}
        openOnInputClick
        itemToStringValue={(item: PickerModel) => item.modelId}
      >
        <ComboboxInput id={id} placeholder="gpt-4o-mini" showClear className="w-full" />

        <ComboboxContent>
          <ComboboxEmpty>
            Nothing in the catalog matches — you can still type any model name.
          </ComboboxEmpty>

          <ComboboxList>
            {(group: PickerGroup) => (
              <ComboboxGroup key={group.value} items={group.items}>
                <ComboboxLabel>{group.value}</ComboboxLabel>
                <ComboboxCollection>
                  {(model: PickerModel) => (
                    // No item indicator can ever show with nothing "selected",
                    // so the room the shadcn item leaves for one goes back to
                    // the row.
                    <ComboboxItem key={model.id} value={model} className="pr-1.5">
                      <span className="truncate font-mono text-xs">{model.modelId}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {detail(model)}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Autocomplete.Root>

      {unrecognised ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Not in the catalog — saving anyway is fine.
        </p>
      ) : null}
    </div>
  )
}
