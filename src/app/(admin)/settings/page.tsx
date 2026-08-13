import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/admin/page-header'
import { requireAdmin } from '@/lib/admin/session'
import { DRIVERS, LOG_SETTINGS_TTL_MS, resolveRequestLogStore } from '@/lib/logs'
import { getLoggingSettings } from '@/lib/settings'
import { GovernanceForm } from './governance-form'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  await requireAdmin()
  const [settings, resolved] = await Promise.all([
    getLoggingSettings(),
    resolveRequestLogStore(),
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
        </TabsContent>
      </Tabs>
    </div>
  )
}
