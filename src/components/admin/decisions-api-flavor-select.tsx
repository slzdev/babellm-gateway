'use client'

import {
  DECISIONS_API_FLAVORS, DECISIONS_API_FLAVOR_LABELS, type DecisionsApiFlavor,
} from '@/lib/decisions-api-flavors'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** Provider default or independent Catalog override. Empty inherits the provider. */
export function DecisionsApiFlavorSelect({ id, defaultValue, providerDefault }: {
  id: string
  defaultValue?: DecisionsApiFlavor | null
  providerDefault?: DecisionsApiFlavor
}) {
  const items = [
    ...(providerDefault ? [{ value: '', label: `(inherit — ${DECISIONS_API_FLAVOR_LABELS[providerDefault]})` }] : []),
    ...DECISIONS_API_FLAVORS.map((value) => ({ value, label: DECISIONS_API_FLAVOR_LABELS[value] })),
  ]
  return (
    <Select
      name="decisionsApiFlavor"
      defaultValue={defaultValue ?? (providerDefault ? '' : 'openai')}
      items={items}
    >
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
