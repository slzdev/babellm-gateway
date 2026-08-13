import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { listVirtualModels } from '@/lib/admin/models'
import { requireAdmin } from '@/lib/admin/session'
import { CreateModelDialog } from './model-form'

export const dynamic = 'force-dynamic'

export default async function ModelsPage() {
  await requireAdmin()
  const models = await listVirtualModels()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Virtual models"
        description="The model names your API keys call. Each one routes to upstream models."
        action={<CreateModelDialog />}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Load balancing</TableHead>
            <TableHead className="text-right">Targets</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-0"><span className="sr-only">Manage</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((model) => (
            <TableRow key={model.id}>
              <TableCell className="font-medium">
                {model.name}
                {model.description ? (
                  <div className="text-xs font-normal text-muted-foreground">
                    {model.description}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground">{model.policy}</TableCell>
              {/* A model with no targets answers every request with a 503, and
                  the count is the only place that shows on the list. */}
              <TableCell
                className={`text-right tabular-nums${model.targets.length === 0 ? ' text-destructive' : ''}`}
              >
                {model.targets.length === 0 ? '0 ⚠' : model.targets.length}
              </TableCell>
              <TableCell>
                <Badge variant={model.enabled ? 'default' : 'secondary'}>
                  {model.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button variant="outline" size="sm" render={<Link href={`/models/${model.id}`} />}>
                  Manage
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {models.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                No virtual models yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}
