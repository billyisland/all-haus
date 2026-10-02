'use client'

// =============================================================================
// LedgerPanel — the reading-tab / earnings ledger body, extracted so the
// workspace Glasshouse overlay (LedgerOverlay) owns it. What you owe and what
// you are owed — two figures, never a net — plus the free
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
import { SettleNowButton } from './SettleNowButton'
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
  // Bumped by a completed settlement so the balance and the reads below it
  // re-read: the charge moves both, and a panel still showing the old tab would
  // invite the reader to settle it twice.
  const [reloadKey, setReloadKey] = useState(0)

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
  }, [user, reloadKey])

  if (loading || !user) {
    const skeleton = (
      <>
        <div className="h-32 animate-pulse bg-glasshouse-well mb-8" />
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
      </>
    )
    return inOverlay ? skeleton : <PageShell width="content">{skeleton}</PageShell>
  }

  // NOT `earningsTotalPence`. That is LIFETIME earnings — `platform_settled +
  // writer_paid`, the payment service's own comment — so it includes every
  // penny already transferred to the writer's bank, and a writer paid £500 over
  // a year would read it as £500 still to come. The figure that means "owed to
  // you and not yet sent" is `pendingTransferPence` (platform_settled and
  // unclaimed by a payout). A pure reader has 0 of it.
  const earningsPence = earnings?.pendingTransferPence ?? 0
  // `tabBalancePence` is the field the route actually sends. This read was
  // `tab?.balancePence` — a name that has never been on the wire — so it was
  // permanently `undefined` and the fallback made it 0: a reader who owed money
  // saw a tab as though they owed none. See the TabOverview docblock.
  const tabBalance = tab?.tabBalancePence ?? 0
  // THE TWO FIGURES ARE NOT SUBTRACTED, and that is the rule, not the layout.
  // This was `earningsPence - tabBalance`, passed to the header as one "Net
  // balance" — the set-off Reader Terms 11.1 says we do not do, and do not in
  // fact do: a writer's pending earnings pay out to their bank and never
  // against their reading tab, so the netted figure named a settlement that
  // could not happen. They travel to BalanceHeader as two values and are
  // rendered as two labelled figures; see that file's header.

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
          tabBalancePence={tabBalance}
          refundDuePence={tab?.refundDuePence ?? 0}
          pendingEarningsPence={earningsPence}
          freeAllowanceRemainingPence={tab?.freeAllowanceRemainingPence ?? user.freeAllowanceRemainingPence}
          freeAllowanceTotalPence={freeAllowanceTotalPence}
          reservedForTributesPence={tributesEnabled() ? (earnings?.reservedPence ?? 0) : 0}
          grossEarnedPence={earnings?.grossPence ?? 0}
          platformFeePence={earnings?.feePence ?? 0}
          allowanceCoveredPence={earnings?.allowanceCoveredPence ?? 0}
          allowanceReadCount={earnings?.allowanceReadCount ?? 0}
        />
      )}

      {/* Reader Terms 5.3. Offered only where it can do something: money owed,
          a card on file, and no terminal decline standing against it — the last
          has its own prompt above, carrying the action that would fix it. */}
      {!dataLoading &&
        tabBalance > 0 &&
        user.hasPaymentMethod &&
        !user.cardActionRequiredAt && (
          <SettleNowButton
            balancePence={tabBalance}
            onSettled={() => setReloadKey((k) => k + 1)}
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
