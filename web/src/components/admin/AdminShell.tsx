'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { PageShell } from '../ui/PageShell'

// =============================================================================
// Owner dashboard chrome — shared auth guard + tab navigation for /admin/*.
// The only chrome here is the sitewide nav bar (whose lockup points a member
// at /reader); the shell still carries its own labelled way back to the
// workspace. Spec: planning-archive/OWNER-DASHBOARD-SPEC.md
//
// IT ALSO CLEARS THE NAV BAR. LayoutShell mounts the fixed PublicNavBar on
// every non-workspace route, `/admin/*` included — a member who lands here from
// a bookmark has no ∀ otherwise. The bar is fixed along the top, so the page
// has to reserve its band itself or the title sits underneath it. That's
// what `--ah-bar-band` is for, and PageShell can't own it: PageShell is also
// the body of five Glasshouse overlay panels, where there is no bar to clear.
// =============================================================================

const TABS = [
  { href: '/admin/overview', label: 'Overview' },
  { href: '/admin/reports', label: 'Reports' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/content', label: 'Content' },
  { href: '/admin/config', label: 'Config' },
  { href: '/admin/regulatory', label: 'Regulatory' },
  { href: '/admin/waitlist', label: 'Waitlist' },
] as const

export function AdminShell({
  title,
  width = 'content',
  children,
}: {
  title: string
  width?: 'article' | 'feed' | 'content'
  children: ReactNode
}) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (loading) return
    if (!user || !user.isAdmin) {
      router.replace('/reader')
    }
  }, [user, loading, router])

  if (loading || !user?.isAdmin) {
    return (
      <div style={{ paddingTop: 'var(--ah-bar-band, 0px)' }}>
        <PageShell width={width}>
          <div className="h-32 animate-pulse bg-white" />
        </PageShell>
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 'var(--ah-bar-band, 0px)' }}>
    <PageShell
      width={width}
      title={title}
      action={
        <Link href="/reader" className="btn-text-muted">
          ← Back to the workspace
        </Link>
      }
    >
      <nav aria-label="Owner dashboard sections" className="flex flex-wrap gap-2 mb-8">
        {TABS.map((t) => {
          const active = pathname === t.href || pathname?.startsWith(`${t.href}/`)
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`tab-pill ${active ? 'tab-pill-active' : 'tab-pill-inactive'}`}
              aria-current={active ? 'page' : undefined}
            >
              {t.label}
            </Link>
          )
        })}
      </nav>
      {children}
    </PageShell>
    </div>
  )
}
