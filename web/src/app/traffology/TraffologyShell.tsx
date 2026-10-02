'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PageShell } from '../../components/ui/PageShell'
import { WriterAccessPage } from '../../components/writer/WriterAccessPanel'
import { useAuth } from '../../stores/auth'

export function TraffologyShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  // A signed-in READER has no analytics to read (READER-WRITER-SPLIT-ADR
  // §6.2): the explanation, not an empty surface. Signed-out is each page's own
  // redirect to login, unchanged.
  const isReader = useAuth((s) => s.user !== null && s.user.canWrite !== true)
  if (isReader) return <WriterAccessPage />

  const navItems = [
    { href: '/traffology', label: 'Feed' },
    { href: '/traffology/overview', label: 'Overview' },
  ]

  // The band clears the fixed PublicNavBar LayoutShell mounts on every
  // non-workspace route — see AdminShell for why PageShell can't own it.
  return (
    <div style={{ paddingTop: 'var(--ah-bar-band, 0px)' }}>
    <PageShell width="content">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-1">
          <span className="label-ui font-bold text-black">
            ∀ Traffology
          </span>
          <Link
            href="/reader?overlay=dashboard"
            className="btn-text-muted"
          >
            Dashboard
          </Link>
        </div>
        <div className="w-full h-1 bg-black" />
      </div>

      {/* Tab nav */}
      <div className="flex gap-0 mb-8">
        {navItems.map((item) => {
          const isActive =
            item.href === '/traffology'
              ? pathname === '/traffology'
              : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-4 py-2 text-ui-xs font-medium border-2 border-black border-r-0 last:border-r-2 transition-colors ${
                isActive
                  ? 'bg-black text-white'
                  : 'bg-transparent text-black hover:bg-grey-100'
              }`}
            >
              {item.label}
            </Link>
          )
        })}
      </div>

      {children}
    </PageShell>
    </div>
  )
}
