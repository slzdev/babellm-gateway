import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/admin/page-header'
import { listUsers } from '@/lib/admin/keys'
import { requireAdmin } from '@/lib/admin/session'
import { CreateUserDialog } from './create-user-form'
import { UserRowActions } from './user-row-actions'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  await requireAdmin()
  const users = await listUsers()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Labels for attributing API keys. Users do not sign in."
        action={<CreateUserDialog />}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead className="w-0"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="font-medium">{user.name}</TableCell>
              <TableCell>{user.email ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground">{user.notes ?? '—'}</TableCell>
              <TableCell className="text-right">
                <UserRowActions id={user.id} name={user.name} />
              </TableCell>
            </TableRow>
          ))}
          {users.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                No users yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}
