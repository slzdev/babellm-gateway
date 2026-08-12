import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { listApiKeys, listUsers } from '@/lib/admin/keys'
import { requireAdmin } from '@/lib/admin/session'
import { CreateKeyDialog } from './key-form'
import { KeyRowActions } from './key-row-actions'

export const dynamic = 'force-dynamic'

function limits(key: {
  rpmLimit: number | null
  tpmLimit: number | null
  budgetMonthlyUsd: string | number | null
}) {
  return [
    key.rpmLimit && `${key.rpmLimit} rpm`,
    key.tpmLimit && `${key.tpmLimit} tpm`,
    key.budgetMonthlyUsd && `$${key.budgetMonthlyUsd}/mo`,
  ].filter(Boolean).join(' · ') || 'none'
}

export default async function KeysPage() {
  await requireAdmin()
  const [keys, users] = await Promise.all([listApiKeys(), listUsers()])

  return (
    <div className="space-y-6">
      <PageHeader
        title="API keys"
        description="Rate limits and budgets are recorded but not enforced until Phase 4."
        action={<CreateKeyDialog users={users} />}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Limits</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-0"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key) => (
            <TableRow key={key.id}>
              <TableCell className="font-medium">{key.name}</TableCell>
              <TableCell className="font-mono text-xs">{key.keyPrefix}…</TableCell>
              <TableCell>{key.userName ?? '—'}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{limits(key)}</TableCell>
              <TableCell className="text-muted-foreground">
                {key.lastUsedAt
                  ? key.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ')
                  : 'never'}
              </TableCell>
              <TableCell>
                <Badge variant={key.enabled ? 'default' : 'secondary'}>
                  {key.enabled ? 'active' : 'revoked'}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <KeyRowActions id={key.id} name={key.name} enabled={key.enabled} />
              </TableCell>
            </TableRow>
          ))}
          {keys.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                No API keys yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}
