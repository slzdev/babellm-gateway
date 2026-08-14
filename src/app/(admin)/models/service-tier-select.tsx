'use client'

import { SERVICE_TIERS, type ServiceTier } from '@/lib/service-tiers'

/**
 * The tier selector both target dialogs render.
 *
 * A bare `<select>` rather than the shadcn Select, matching the Provider and
 * Policy fields beside it: these dialogs submit real FormData, and shadcn's
 * Select is not a native form control.
 *
 * "(none)" submits an empty string, which the action turns back into NULL —
 * the value that leaves the request untouched.
 */
export function ServiceTierSelect({
  id,
  defaultValue,
}: {
  id: string
  defaultValue?: ServiceTier | null
}) {
  return (
    <select
      id={id}
      name="serviceTier"
      defaultValue={defaultValue ?? ''}
      className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
    >
      <option value="">(none)</option>
      {SERVICE_TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
    </select>
  )
}
