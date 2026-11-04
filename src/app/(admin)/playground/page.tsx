import { PageHeader } from '@/components/admin/page-header'
import { listPlaygroundModels } from '@/lib/admin/playground'
import { requireAdmin } from '@/lib/admin/session'
import { Playground } from './playground'

export const dynamic = 'force-dynamic'

export default async function PlaygroundPage() {
  await requireAdmin()
  const models = await listPlaygroundModels()

  return (
    <div className="space-y-6">
      <PageHeader title="Playground" description="Try your models through the gateway with a text conversation." />
      <Playground models={models} />
    </div>
  )
}
