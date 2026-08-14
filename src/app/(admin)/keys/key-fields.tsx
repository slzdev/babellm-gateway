'use client'

import { useId, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/** The settings a key carries, as the form needs them. */
export interface KeyFieldValues {
  name: string
  userId: string | null
  expiresAt: Date | null
  rpmLimit: number | null
  tpmLimit: number | null
  budgetMonthlyUsd: string | null
  budgetTotalUsd: string | null
  logPayloads: boolean
}

/** `<input type="date">` wants a bare YYYY-MM-DD, which is what the action
 * parsed the stored UTC timestamp from in the first place. */
function dateValue(date: Date | null | undefined): string {
  return date ? date.toISOString().slice(0, 10) : ''
}

/** Stored money is a fixed-scale numeric ('25.000000'); show it the way an
 * admin typed it. */
function moneyValue(amount: string | null | undefined): string {
  return amount ? String(Number(amount)) : ''
}

/**
 * Every editable setting on a key, shared by the create and edit dialogs so
 * a field added to one cannot go missing from the other.
 *
 * `values` is what the fields start at — omitted for a new key. The names are
 * the contract with `keyInputFrom` in actions.ts, which reads both forms.
 */
export function KeyFields({
  users, values,
}: {
  users: Array<{ id: string; name: string }>
  values?: KeyFieldValues
}) {
  // Unique per mounted dialog, so a label still points at its own field when
  // more than one of these is on the page.
  const prefix = useId()

  // These fields are uncontrolled, so they read their default exactly once —
  // at mount. Pinning the values to that first render keeps a later `values`
  // from contradicting what the fields are already holding: a successful save
  // revalidates the page, and the fresh row reaches this component while the
  // dialog is still on screen through its exit animation. Base UI warns about
  // precisely that ("changing the default value state of an uncontrolled
  // FieldControl after being initialized"). The dialog unmounts on close, so
  // the next open still starts from current data.
  const [initial] = useState(values)

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-name`}>Name</Label>
          <Input
            id={`${prefix}-name`}
            name="name"
            required
            placeholder="production app"
            defaultValue={initial?.name ?? ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-userId`}>User</Label>
          <select
            id={`${prefix}-userId`}
            name="userId"
            defaultValue={initial?.userId ?? ''}
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="">Unassigned</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-expiresAt`}>Expires</Label>
          <Input
            id={`${prefix}-expiresAt`}
            name="expiresAt"
            type="date"
            defaultValue={dateValue(initial?.expiresAt)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-rpmLimit`}>Requests / min</Label>
          <Input
            id={`${prefix}-rpmLimit`}
            name="rpmLimit"
            type="number"
            min={1}
            defaultValue={initial?.rpmLimit ?? ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-tpmLimit`}>Tokens / min</Label>
          <Input
            id={`${prefix}-tpmLimit`}
            name="tpmLimit"
            type="number"
            min={1}
            defaultValue={initial?.tpmLimit ?? ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-budgetMonthlyUsd`}>Monthly budget (USD)</Label>
          {/* step="any": budgets are stored to six decimals, and a stricter
              step would have the browser reject an existing value on edit
              before the server ever sees it. The server validates the scale. */}
          <Input
            id={`${prefix}-budgetMonthlyUsd`}
            name="budgetMonthlyUsd"
            type="number"
            step="any"
            min={0}
            defaultValue={moneyValue(initial?.budgetMonthlyUsd)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-budgetTotalUsd`}>Total budget (USD)</Label>
          <Input
            id={`${prefix}-budgetTotalUsd`}
            name="budgetTotalUsd"
            type="number"
            step="any"
            min={0}
            defaultValue={moneyValue(initial?.budgetTotalUsd)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id={`${prefix}-logPayloads`}
            name="logPayloads"
            defaultChecked={initial?.logPayloads ?? false}
          />
          <Label htmlFor={`${prefix}-logPayloads`}>Log request and response payloads</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Stores the exact request and response bodies with this key&apos;s logs, up to
          the payload cap in Settings › Governance. Off by default.
        </p>
      </div>
    </>
  )
}
