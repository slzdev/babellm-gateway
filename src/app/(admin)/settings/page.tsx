import { eq } from 'drizzle-orm'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/admin/page-header'
import { requireAdmin } from '@/lib/admin/session'
import { db } from '@/lib/db'
import { settings as settingsTable } from '@/lib/db/schema'
import { healthStoreStatus } from '@/lib/health'
import { DRIVERS, LOG_SETTINGS_TTL_MS, resolveRequestLogStore } from '@/lib/logs'
import { ROUTING_SETTINGS_TTL_MS } from '@/lib/routing-settings'
import { getLoggingSettings, getRoutingSettings } from '@/lib/settings'
import { usageStoreStatus } from '@/lib/usage'
import { GovernanceForm } from './governance-form'
import { RoutingForm } from './routing-form'
import { UsageStatus } from './usage-status'

export const dynamic = 'force-dynamic'

/** Renders the `logs.last_maintenance` settings row. No row yet — a fresh
 * install whose first run has not finished — reads as "never" rather than a
 * blank line. */
function maintenance(
  value: { at: string; created: string[]; dropped: string[] } | null,
): string {
  if (!value) return 'never'
  const at = value.at.slice(0, 19).replace('T', ' ')
  return `${at} — ${value.created.length} created, ${value.dropped.length} dropped`
}

export default async function SettingsPage() {
  await requireAdmin()
  const [settings, resolved, routingSettings, [lastRun]] = await Promise.all([
    getLoggingSettings(),
    resolveRequestLogStore(),
    getRoutingSettings(),
    db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, 'logs.last_maintenance'))
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
            retentionMonths={settings.retentionMonths}
            payloadMaxBytes={settings.payloadMaxBytes}
            activeStore={resolved.store.name}
            ttlSeconds={LOG_SETTINGS_TTL_MS / 1000}
          />
          <RoutingForm
            threshold={routingSettings.threshold}
            cooldownSeconds={routingSettings.cooldownSeconds}
            ttlSeconds={ROUTING_SETTINGS_TTL_MS / 1000}
          />
          <UsageStatus usage={usageStoreStatus()} health={healthStoreStatus()} />
          <p className="pt-6 text-xs text-muted-foreground">
            Maintenance last ran: {maintenance(
              lastRun?.value as { at: string; created: string[]; dropped: string[] } | undefined ?? null,
            )}
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
