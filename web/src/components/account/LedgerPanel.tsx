'use client'

// =============================================================================
// LedgerPanel — the reading-tab / earnings ledger body, extracted so the
// workspace Glasshouse overlay (LedgerOverlay) owns it. Net balance + free
// allowance up top, then the transaction ledger, active subscriptions and
// pledges. The component keeps a page-capable mode (`inOverlay=false`: wrapped
// in PageShell, with the auth redirect) so it can be hosted standalone if
// needed. When `inOverlay` is set, the panel skips the auth redirect (the
// overlay only mounts for authenticated users) and renders a bare body — the
// overlay supplies the frame, width and title.
// =============================================================================

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { account as accountApi, payment, type TabOverview, type WriterEarnings } from '../../lib/api'
import { tributesEnabled } from '../../lib/api/tributes'
import { BalanceHeader } from './BalanceHeader'
import { CardActionRequired } from './CardActionRequired'
import { AccountLedger } from './AccountLedger'
import { SubscriptionsSection } from './SubscriptionsSection'
import { PledgesSection } from './PledgesSection'
import { pledgesEnabled } from '../../lib/featureFlags'
import { PageShell, PageHeader } from '../ui/PageShell'

export function LedgerPanel({ inOverlay = false }: { inOverlay?: boolean }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [tab, setTab] = useState<TabOverview | null>(null)
  const [earnings, setEarnings] = useState<WriterEarnings | null>(null)
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => { if (!inOverlay && !loading && !user) router.push('/auth?mode=login') }, [inOverlay, user, loading, router])

  useEffect(() => {
    if (!user) return
    void (async () => {
      try {
        const [tabData, earningsData] = await Promise.all([
          accountApi.getTab(),
          payment.getEarnings(user.id).catch(() => null),
        ])
        setTab(tabData)
        setEarnings(earningsData)
      } catch {}
      finally { setDataLoading(false) }
    })()
  }, [user])

  if (loading || !user) {
    const skeleton = (
      <>
        <div className="h-32 animate-pulse bg-glasshouse-well mb-8" />
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
      </>
    )
    return inOverlay ? skeleton : <PageShell width="content">{skeleton}</PageShell>
  }

  const earningsPence = earnings?.earningsTotalPence ?? 0
  // `tabBalancePence` is the field the route actually sends. This read was
  // `tab?.balancePence` — a name that has never been on the wire — so it was
  // permanently `undefined`, the fallback made it 0, and the net balance below
  // has been reporting earnings alone: a reader who owed money saw a balance as
  // though they owed none. See the TabOverview docblock.
  const tabBalance = tab?.tabBalancePence ?? 0
  const netBalance = earningsPence - tabBalance

  // The gauge's denominator: what THIS reader was granted (the route sends it
  // alongside what remains). It was a hardcoded 500 here, on the reasoning that
  // £5 is "the constant the allowance is defined by" — but the allowance is a
  // tuning dial, so the constant was only ever right because nothing read the
  // dial. The 500 survives as the pre-response fallback alone: `tab` is null
  // until the fetch lands, and it matches the dial's seeded default.
  const freeAllowanceTotalPence = tab?.freeAllowanceTotalPence ?? 500

  const body = (
    <>
      {inOverlay && <PageHeader title="Ledger" />}

      {/* Before the balance: a frozen tab is the reason the numbers below have
          stopped moving, so it has to be read first. Read off the session rather
          than the tab response so there is ONE source for this fact across every
          surface that shows it — the store re-renders all of them when
          CardSetup's fetchMe lands and the flag clears. */}
      <CardActionRequired since={user.cardActionRequiredAt} />

      {dataLoading ? (
        <div className="h-32 animate-pulse bg-glasshouse-well mb-8" />
      ) : (
        <BalanceHeader
          balancePence={netBalance}
          freeAllowanceRemainingPence={tab?.freeAllowanceRemainingPence ?? user.freeAllowanceRemainingPence}
          freeAllowanceTotalPence={freeAllowanceTotalPence}
          reservedForTributesPence={tributesEnabled() ? (earnings?.reservedPence ?? 0) : 0}
        />
      )}

      <AccountLedger initialIncludeFreeReads={false} />

      <SubscriptionsSection />
      {pledgesEnabled() && <PledgesSection />}
    </>
  )

  if (inOverlay) return body
  return <PageShell width="content" title="Ledger">{body}</PageShell>
}
