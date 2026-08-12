import Link from 'next/link'
import { Toaster } from '@/components/ui/sonner'
import { requireAdmin } from '@/lib/admin/session'

const NAV = [
  { href: '/providers', label: 'Providers' },
  { href: '/models', label: 'Virtual models' },
  { href: '/keys', label: 'API keys' },
  { href: '/users', label: 'Users' },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin()

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <nav className="mx-auto flex max-w-6xl gap-6 px-6 py-4 text-sm">
          <span className="font-semibold">BabeLLM</span>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-muted-foreground hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      <Toaster />
    </div>
  )
}
