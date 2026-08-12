import { Toaster } from '@/components/ui/sonner'
import { requireAdmin } from '@/lib/admin/session'
import { NavLink } from './nav-link'

const NAV = [
  { href: '/providers', label: 'Providers' },
  { href: '/catalog', label: 'Catalog' },
  { href: '/models', label: 'Virtual models' },
  { href: '/keys', label: 'API keys' },
  { href: '/users', label: 'Users' },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin()

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="px-5 py-4 text-sm font-semibold">BabeLLM</div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
          {NAV.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
      </main>
      <Toaster />
    </div>
  )
}
