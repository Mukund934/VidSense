'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Route } from 'next'

/**
 * A navigation link that knows whether you are already on it.
 *
 * The header previously gave no indication of the current page, so "History"
 * and "Settings" looked identical whether you were on them or not. The underline
 * grows from the centre rather than fading in, because a line that appears is a
 * decoration and a line that draws itself is a direction.
 */
export function NavLink({ href, children }: { href: Route; children: React.ReactNode }) {
  const pathname = usePathname()
  // Prefix rather than equality: /history/watched is still History.
  const active = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`group relative py-1 transition-colors duration-[var(--dur-fast)] ${
        active ? 'text-ink' : 'text-muted hover:text-ink'
      }`}
    >
      {children}
      <span
        aria-hidden
        className={`absolute inset-x-0 -bottom-0.5 h-px origin-center bg-accent
                    transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]
                    ${active ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'}`}
      />
    </Link>
  )
}
