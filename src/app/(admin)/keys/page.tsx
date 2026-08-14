import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { listApiKeys, listUsers } from '@/lib/admin/keys'
import { requireAdmin } from '@/lib/admin/session'
import { readUsage, type UsageReading } from '@/lib/usage'
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
    key.budgetMonthlyUsd && `$${Number(key.budgetMonthlyUsd).toFixed(2)}/mo`,
  ].filter(Boolean).join(' · ') || 'none'
}

/** What the key has actually used, against what it is allowed. An em dash
 * for a key with no limits: it has no counters, and a 0 would claim it had
 * never been used rather than that nothing was ever counted. */
function usage(reading: UsageReading | undefined) {
  if (!reading) return '—'
  return [
    reading.rpm !== null && `${reading.rpm} rpm`,
    reading.tpm !== null && `${reading.tpm} tpm`,
    reading.monthUsd !== null && `$${reading.monthUsd.toFixed(2)}/mo`,
    reading.totalUsd !== null && `$${reading.totalUsd.toFixed(2)} total`,
  ].filter(Boolean).join(' · ') || '—'
}

export default async function KeysPage() {
  await requireAdmin()
  const [keys, users] = await Promise.all([listApiKeys(), listUsers()])
  const readings = await readUsage(keys)

  return (
    <div className="space-y-6">
      <PageHeader
        title="API keys"
        description="Rate limits and budgets are enforced on every request. Counters are held in memory unless REDIS_URL is set, and reset when the gateway restarts."
        action={<CreateKeyDialog users={users} />}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Limits</TableHead>
            <TableHead>Usage</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Payloads</TableHead>
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
              <TableCell className="text-xs text-muted-foreground">
                {usage(readings.get(key.id))}
              </TableCell>
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
              <TableCell>
                <Badge variant={key.logPayloads ? 'default' : 'outline'}>
                  {key.logPayloads ? 'captured' : 'off'}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <KeyRowActions
                  id={key.id} name={key.name} enabled={key.enabled} logPayloads={key.logPayloads}
                />
              </TableCell>
            </TableRow>
          ))}
          {keys.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                No API keys yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}
