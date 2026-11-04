import { PageHeader } from '@/components/admin/page-header'
import { listPlaygroundApiKeys, listPlaygroundModels } from '@/lib/admin/playground'
import { requireAdmin } from '@/lib/admin/session'
import { Playground } from './playground'

export const dynamic = 'force-dynamic'

export default async function PlaygroundPage() {
  await requireAdmin()
  const [models, apiKeys] = await Promise.all([listPlaygroundModels(), listPlaygroundApiKeys()])

  return (
    <div className="space-y-6" data-page-width="full">
      <PageHeader title="Playground" description="Try your models through the gateway with a text conversation." />
      <Playground models={models} apiKeys={apiKeys} />
    </div>
  )
}
