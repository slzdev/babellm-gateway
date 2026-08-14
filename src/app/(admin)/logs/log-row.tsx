'use client'

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { TableRow } from '@/components/ui/table'

/**
 * A log row whose whole surface navigates to the request's detail page.
 *
 * The time cell still holds a real `<Link>`: that is what keyboard users tab
 * to, what "open in new tab" acts on, and what the browser shows in the
 * status bar. This wrapper only widens the *pointer* target to the rest of
 * the row — it is deliberately not an accessibility affordance of its own,
 * so the row carries no link role that would duplicate the anchor for screen
 * readers.
 */
export function LogRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter()

  function navigate(event: React.MouseEvent<HTMLTableRowElement>) {
    // The anchor in the time cell (and anything else interactive we may add)
    // handles its own click — following it here too would navigate twice and
    // break modifier-click behaviour the browser already gets right.
    if ((event.target as HTMLElement).closest('a, button, input, [role="menu"]')) return
    // Selecting text inside a row is not a request to leave it.
    if (window.getSelection()?.toString()) return

    // Match what an anchor would do for a modified click, so the widened hit
    // area behaves like the link it stands in for.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
      window.open(href, '_blank', 'noopener')
      return
    }
    router.push(href)
  }

  return (
    <TableRow
      className="cursor-pointer"
      onClick={navigate}
      onAuxClick={(event) => { if (event.button === 1) navigate(event) }}
    >
      {children}
    </TableRow>
  )
}
