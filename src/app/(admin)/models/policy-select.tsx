'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { setPolicyAction } from './actions'
import type { RoutingPolicy } from '@/lib/admin/models'

const POLICIES: RoutingPolicy[] = ['failover', 'weighted', 'round_robin']

export function PolicySelect({ id, policy }: { id: string; policy: RoutingPolicy }) {
  const [pending, startTransition] = useTransition()

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value as RoutingPolicy
    startTransition(async () => {
      try {
        await setPolicyAction(id, next)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the policy.')
      }
    })
  }

  return (
    <select
      aria-label="Routing policy"
      defaultValue={policy}
      disabled={pending}
      onChange={handleChange}
      className="h-8 rounded-md border bg-transparent px-2 text-sm"
    >
      {POLICIES.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  )
}
