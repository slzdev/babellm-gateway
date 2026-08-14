import { Toaster } from '@/components/ui/sonner'
import { requireAdmin } from '@/lib/admin/session'
import { NavLink } from './nav-link'

interface NavItem {
  href: string
  label: string
}

interface NavSection {
  /** Rendered as a small heading above the group. Absent for the first,
   * unlabeled group. */
  label?: string
  items: NavItem[]
}

const NAV: NavSection[] = [
  {
    items: [
      { href: '/providers', label: 'Providers' },
      { href: '/catalog', label: 'Catalog' },
      { href: '/models', label: 'Virtual models' },
      { href: '/keys', label: 'API keys' },
      { href: '/users', label: 'Users' },
    ],
  },
  {
    label: 'Governance',
    items: [{ href: '/logs', label: 'Request logs' }],
  },
]

/** Settings is not part of Governance: it will hold settings for every area of
 * the app, with Governance as one tab inside it. */
const FOOTER_NAV: NavItem[] = [{ href: '/settings', label: 'Settings' }]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin()

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="px-5 py-4 text-sm font-semibold">BabeLLM</div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
          {NAV.map((section, index) => {
            const headingId = section.label ? `nav-section-${index}-heading` : undefined
            return (
              <div
                key={section.label ?? index}
                className="flex flex-col gap-1"
                role={section.label ? 'group' : undefined}
                aria-labelledby={headingId}
              >
                {section.label ? (
                  <div
                    id={headingId}
                    className="px-3 pt-4 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {section.label}
                  </div>
                ) : null}
                {section.items.map((item) => (
                  <NavLink key={item.href} href={item.href} label={item.label} />
                ))}
              </div>
            )
          })}

          <div className="mt-auto flex flex-col gap-1 pt-4">
            {FOOTER_NAV.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </div>
        </nav>
      </aside>
      <main className="relative flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
      </main>
      <Toaster />
    </div>
  )
}
