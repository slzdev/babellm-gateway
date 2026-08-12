import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { listApiKeys, listUsers } from '@/lib/admin/keys'
import { requireAdmin } from '@/lib/admin/session'
import { deleteKeyAction, revokeKeyAction } from './actions'
import { CreateKeyForm } from './key-form'

export const dynamic = 'force-dynamic'

export default async function KeysPage() {
  await requireAdmin()
  const [keys, users] = await Promise.all([listApiKeys(), listUsers()])

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Rate limits and budgets are recorded but not enforced until Phase 4.
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">Name</th><th>Key</th><th>User</th>
            <th>Limits</th><th>Last used</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className="border-t">
              <td className="py-2 font-medium">{key.name}</td>
              <td className="font-mono text-xs">{key.keyPrefix}…</td>
              <td>{key.userName ?? '—'}</td>
              <td className="text-xs text-muted-foreground">
                {[key.rpmLimit && `${key.rpmLimit} rpm`,
                  key.tpmLimit && `${key.tpmLimit} tpm`,
                  key.budgetMonthlyUsd && `$${key.budgetMonthlyUsd}/mo`]
                  .filter(Boolean).join(' · ') || 'none'}
              </td>
              <td>{key.lastUsedAt ? key.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ') : 'never'}</td>
              <td><Badge variant={key.enabled ? 'default' : 'secondary'}>{key.enabled ? 'active' : 'revoked'}</Badge></td>
              <td className="space-x-1 text-right">
                <form action={revokeKeyAction} className="inline">
                  <input type="hidden" name="id" value={key.id} />
                  <input type="hidden" name="enabled" value={String(!key.enabled)} />
                  <Button type="submit" variant="ghost" size="sm">
                    {key.enabled ? 'Revoke' : 'Restore'}
                  </Button>
                </form>
                <form action={deleteKeyAction} className="inline">
                  <input type="hidden" name="id" value={key.id} />
                  <Button type="submit" variant="ghost" size="sm">Delete</Button>
                </form>
              </td>
            </tr>
          ))}
          {keys.length === 0 ? (
            <tr><td colSpan={7} className="py-6 text-muted-foreground">No API keys yet.</td></tr>
          ) : null}
        </tbody>
      </table>

      <CreateKeyForm users={users} />
    </div>
  )
}
