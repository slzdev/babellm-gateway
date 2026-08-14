'use client'

import { useActionState, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { saveLoggingSettingsAction, type ActionState } from './actions'

export function GovernanceForm({
  drivers,
  store,
  retentionMonths,
  payloadMaxBytes,
  activeStore,
  ttlSeconds,
}: {
  drivers: Array<{ name: string; readable: boolean }>
  store: string
  retentionMonths: number
  payloadMaxBytes: number
  activeStore: string
  ttlSeconds: number
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    saveLoggingSettingsAction,
    undefined,
  )

  // Controlled, like the policy Select in models/[id]/settings-form.tsx: a
  // successful save revalidates and hands this form the same `store` prop it
  // just submitted, but on a form that hasn't remounted — Base UI warns about
  // reassigning `defaultValue` on an uncontrolled Select in that situation.
  const [selectedStore, setSelectedStore] = useState(store)

  useEffect(() => {
    if (state?.error) toast.error(state.error)
    if (state?.success) toast.success(state.success)
  }, [state])

  return (
    <form action={action} className="max-w-xl space-y-6">
      <div className="space-y-2">
        <Label htmlFor="store">Request log store</Label>
        <Select
          name="store"
          value={selectedStore}
          // Base UI types the change value as nullable for clearable selects;
          // this one has no empty item, so a null can only be spurious.
          onValueChange={(value) => { if (value) setSelectedStore(value) }}
        >
          <SelectTrigger id="store" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {drivers.map((driver) => (
              <SelectItem key={driver.name} value={driver.name}>
                {driver.name}{driver.readable ? '' : ' — write only'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Switching stores does not move existing logs. The previous store keeps its
          rows; this page and the log viewer show the new store only, and switching
          back brings the old rows back into view. Other running instances pick up a
          change within {ttlSeconds} seconds.
        </p>
        <p className="text-xs text-muted-foreground">
          DynamoDB appears in this list only on instances where{' '}
          <span className="font-mono">DYNAMODB_LOGS_TABLE</span> is set. An unconfigured
          driver is not offered.
        </p>
        {activeStore !== store ? (
          <p className="text-xs text-destructive">
            Currently logging to <span className="font-mono">{activeStore}</span>, because
            the configured store could not be used.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="retentionMonths">Retention (months)</Label>
        <Input
          id="retentionMonths" name="retentionMonths" type="number" min={0} required
          defaultValue={retentionMonths}
        />
        <p className="text-xs text-muted-foreground">
          Logs are stored one month per table and discarded a whole month at a time,
          daily. A value of N keeps the current month and the N−1 before it, so the
          youngest logs are always kept in full. Set 0 to keep everything, which means
          you are responsible for the database&apos;s growth.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="payloadMaxBytes">Payload size cap (bytes)</Label>
        <Input
          id="payloadMaxBytes" name="payloadMaxBytes" type="number" min={1}
          defaultValue={payloadMaxBytes}
        />
        <p className="text-xs text-muted-foreground">
          Applies to keys with payload logging enabled. Anything larger is stored as a
          truncated preview.
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  )
}
