import { Button } from '@/components/ui/button'
import { listUsers } from '@/lib/admin/keys'
import { requireAdmin } from '@/lib/admin/session'
import { deleteUserAction } from './actions'
import { CreateUserForm } from './create-user-form'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  await requireAdmin()
  const users = await listUsers()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Labels for attributing API keys. Users do not sign in.
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr><th className="py-2">Name</th><th>Email</th><th>Notes</th><th /></tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-t">
              <td className="py-2 font-medium">{user.name}</td>
              <td>{user.email ?? '—'}</td>
              <td className="text-muted-foreground">{user.notes ?? '—'}</td>
              <td className="text-right">
                <form action={deleteUserAction}>
                  <input type="hidden" name="id" value={user.id} />
                  <Button type="submit" variant="ghost" size="sm">Delete</Button>
                </form>
              </td>
            </tr>
          ))}
          {users.length === 0 ? (
            <tr><td colSpan={4} className="py-6 text-muted-foreground">No users yet.</td></tr>
          ) : null}
        </tbody>
      </table>

      <CreateUserForm />
    </div>
  )
}
