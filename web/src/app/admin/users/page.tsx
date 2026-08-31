'use client'

import { useEffect, useState } from 'react'
import { adminDashboard, type AdminUsers } from '../../../lib/api'
import { formatPence } from '../../../lib/format'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'
import { ProfileLink } from '../../../components/ui/ProfileLink'

export default function AdminUsersPage() {
  const [data, setData] = useState<AdminUsers | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    adminDashboard
      .users()
      .then(setData)
      .catch(() => setError('Failed to load user metrics.'))
  }, [])

  return (
    <AdminShell title="Site owner">
      {error && <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>}
      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      )}
      {data && (
        <>
          <StatSection label="Accounts">
            <StatGrid>
              <StatCard label="Total" value={data.totals.accounts} />
              <StatCard label="Active" value={data.totals.active} />
              <StatCard
                label="Suspended"
                value={data.totals.suspended}
                warn={data.totals.suspended > 0}
              />
              <StatCard label="Deactivated" value={data.totals.deactivated} />
              <StatCard label="Cards on file" value={data.totals.readersWithCard} />
              <StatCard label="On free allowance" value={data.totals.readersOnFreeAllowance} />
              <StatCard label="Allowance exhausted" value={data.totals.readersAllowanceExhausted} />
              <StatCard
                label="Card action required"
                value={data.totals.cardActionRequired}
                warn={data.totals.cardActionRequired > 0}
                detail="Settlement declines awaiting re-auth"
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Growth">
            <StatGrid>
              <StatCard label="Signups, 7 days" value={data.growth.signupsLast7d} />
              <StatCard label="Signups, 30 days" value={data.growth.signupsLast30d} />
            </StatGrid>
          </StatSection>

          <StatSection
            label="Conversion funnel"
            helper="Readers who exhausted the free allowance, and how many connected a card."
          >
            <StatGrid>
              <StatCard label="Readers ever" value={data.conversionFunnel.totalReadersEver} />
              <StatCard label="Exhausted allowance" value={data.conversionFunnel.exhaustedAllowance} />
              <StatCard label="Connected a card" value={data.conversionFunnel.connectedCard} />
              <StatCard
                label="Conversion"
                value={
                  data.conversionFunnel.conversionRate === null
                    ? '—'
                    : `${Math.round(data.conversionFunnel.conversionRate * 100)}%`
                }
              />
            </StatGrid>
          </StatSection>

          <StatSection
            label="KYC incomplete, holding earnings"
            helper="Writers the platform owes money it cannot pay out — earnings accumulate as a liability until Stripe onboarding completes."
          >
            {data.kycIncomplete.count === 0 ? (
              <p className="text-ui-sm text-grey-600">None — every earning writer can be paid.</p>
            ) : (
              <div className="bg-glasshouse-well px-6 py-5">
                <table className="w-full text-ui-xs">
                  <thead>
                    <tr className="border-b-2 border-grey-200">
                      <th className="label-ui text-grey-600 text-left pb-2">Writer</th>
                      <th className="label-ui text-grey-600 text-left pb-2">Connect</th>
                      <th className="label-ui text-grey-600 text-right pb-2">Owed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.kycIncomplete.writers.map((w) => (
                      <tr key={w.id}>
                        <td className="py-2">
                          <ProfileLink href={`/${w.username}`} className="text-black">
                            {w.displayName ?? w.username}
                          </ProfileLink>
                        </td>
                        <td className="py-2 text-grey-600">
                          {w.connectStarted ? 'Started, incomplete' : 'Not started'}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatPence(w.pendingEarningsPence)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </StatSection>

          <p className="text-ui-xs text-grey-600">
            Account search and suspension live on the Reports tab (via reported content) — a
            standalone account search is a follow-on.
          </p>
        </>
      )}
    </AdminShell>
  )
}
