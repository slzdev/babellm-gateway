'use client'

import { useActionState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { saveRoutingSettingsAction, type ActionState } from './actions'

export function RoutingForm({
  threshold,
  cooldownSeconds,
  ttlSeconds,
}: {
  threshold: number
  cooldownSeconds: number
  ttlSeconds: number
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    saveRoutingSettingsAction,
    undefined,
  )

  useEffect(() => {
    if (state?.error) toast.error(state.error)
    if (state?.success) toast.success(state.success)
  }, [state])

  return (
    <form action={action} className="max-w-xl space-y-6">
      <div className="space-y-2">
        <Label htmlFor="breakerThreshold">Breaker threshold</Label>
        <Input
          id="breakerThreshold"
          name="breakerThreshold"
          type="number"
          min={0}
          defaultValue={threshold}
          required
        />
        <p className="text-xs text-muted-foreground">
          Consecutive failures before a route target is demoted. 0 disables the
          breaker entirely.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="breakerCooldownSeconds">Breaker cooldown (seconds)</Label>
        <Input
          id="breakerCooldownSeconds"
          name="breakerCooldownSeconds"
          type="number"
          min={1}
          defaultValue={cooldownSeconds}
        />
        <p className="text-xs text-muted-foreground">
          How long a demoted target stays behind its healthy siblings. The first
          request after it lapses probes the target, and a single further
          failure demotes it again. Changes reach other gateway instances within{' '}
          {ttlSeconds} seconds.
        </p>
      </div>
      <Button type="submit" disabled={pending}>Save</Button>
    </form>
  )
}
