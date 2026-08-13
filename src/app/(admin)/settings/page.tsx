import { eq } from 'drizzle-orm'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/admin/page-header'
import { requireAdmin } from '@/lib/admin/session'
import { db } from '@/lib/db'
import { settings as settingsTable } from '@/lib/db/schema'
import { DRIVERS, LOG_SETTINGS_TTL_MS, resolveRequestLogStore } from '@/lib/logs'
import { getLoggingSettings } from '@/lib/settings'
import { GovernanceForm } from './governance-form'

export const dynamic = 'force-dynamic'

/** Renders the `logs.last_prune` settings row. No row yet (a fresh install,
 * or retention has always been disabled) reads as "never" rather than a
 * blank line. */
function prune(value: { at: string; deleted: number } | null): string {
  if (!value) return 'never'
  const at = value.at.slice(0, 19).replace('T', ' ')
  return `${at} — ${value.deleted} row${value.deleted === 1 ? '' : 's'} deleted`
}

export default async function SettingsPage() {
  await requireAdmin()
  const [settings, resolved, [lastPrune]] = await Promise.all([
    getLoggingSettings(),
    resolveRequestLogStore(),
    db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, 'logs.last_prune'))
      .limit(1),
  ])

  const drivers = Object.values(DRIVERS).map((driver) => ({
    name: driver.name,
    readable: driver.readable,
  }))

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Gateway-wide configuration." />

      <Tabs defaultValue="governance">
        <TabsList>
          <TabsTrigger value="governance">Governance</TabsTrigger>
        </TabsList>
        <TabsContent value="governance" className="pt-6">
          <GovernanceForm
            drivers={drivers}
            store={settings.store}
            retentionDays={settings.retentionDays}
            payloadMaxBytes={settings.payloadMaxBytes}
            activeStore={resolved.store.name}
            ttlSeconds={LOG_SETTINGS_TTL_MS / 1000}
          />
          <p className="pt-6 text-xs text-muted-foreground">
            Retention last ran: {prune(lastPrune?.value as { at: string; deleted: number } | undefined ?? null)}
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
