'use client'

import { useEffect, useState } from 'react'
import { adminDashboard, type AdminRegulatory } from '../../../lib/api'
import { formatPence } from '../../../lib/format'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'

function ThresholdRow({
  label,
  currentPence,
  thresholdPence,
  status,
  warn,
}: {
  label: string
  currentPence: number
  thresholdPence: number
  status: string
  warn: boolean
}) {
  const pct = thresholdPence > 0 ? Math.min(100, (currentPence / thresholdPence) * 100) : 0
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <p className="label-ui text-grey-600">{label}</p>
        <p className={`text-mono-xs ${warn ? 'text-crimson' : 'text-grey-600'}`}>
          {status.replace(/_/g, ' ')}
        </p>
      </div>
      <div className="h-2 bg-white" aria-hidden>
        <div
          className={warn ? 'h-2 bg-crimson' : 'h-2 bg-black'}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-ui-xs text-grey-600 mt-1 tabular-nums">
        {formatPence(currentPence)} of {formatPence(thresholdPence)} ({pct.toFixed(1)}%)
      </p>
    </div>
  )
}

export default function AdminRegulatoryPage() {
  const [data, setData] = useState<AdminRegulatory | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    adminDashboard
      .regulatory()
      .then(setData)
      .catch(() => setError('Failed to load regulatory metrics.'))
  }, [])

  return (
    <AdminShell title="Site owner">
      {error && <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>}
      {!data && !error && (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      )}
      {data && (
        <>
          <StatSection label="Platform revenue" helper="Platform fee revenue, not gross reader spend.">
            <StatGrid>
              <StatCard
                label="Rolling 12 months"
                value={formatPence(data.rolling12MonthRevenuePence)}
              />
              <StatCard label="This month" value={formatPence(data.currentMonthRevenuePence)} />
              <StatCard
                label="Annualised run rate"
                value={formatPence(data.annualisedRunRatePence)}
                detail="This month × 12"
              />
              <StatCard
                label="Tax year"
                value={`${data.financialYear.daysRemaining}d left`}
                detail={`${data.financialYear.start} → ${data.financialYear.end}`}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Threshold ladder" helper="Rolling 12-month revenue against each UK threshold.">
            <div className="bg-glasshouse-well/40 px-6 py-5 space-y-6">
              <ThresholdRow
                label="Trading allowance / self-assessment"
                currentPence={data.thresholds.tradingAllowance.currentPence}
                thresholdPence={data.thresholds.tradingAllowance.thresholdPence}
                status={data.thresholds.tradingAllowance.status}
                warn={data.thresholds.tradingAllowance.status === 'exceeded'}
              />
              <ThresholdRow
                label="VAT registration"
                currentPence={data.thresholds.vatRegistration.currentPence}
                thresholdPence={data.thresholds.vatRegistration.thresholdPence}
                status={data.thresholds.vatRegistration.status}
                warn={data.thresholds.vatRegistration.status !== 'clear'}
              />
              <ThresholdRow
                label="Corporation tax (small profits)"
                currentPence={data.thresholds.corporationTax.currentRevenuePence}
                thresholdPence={data.thresholds.corporationTax.smallProfitsThresholdPence}
                status={data.thresholds.corporationTax.status}
                warn={data.thresholds.corporationTax.status !== 'below_small_profits'}
              />
              <p className="text-ui-xs text-grey-600">
                Corporation tax thresholds apply to <em>profit</em>; revenue is compared here as a
                conservative proxy.
              </p>
            </div>
          </StatSection>

          <StatSection
            label="Custodial exposure"
            helper="Money held between reader settlement and writer payout."
          >
            <StatGrid>
              <StatCard label="Held" value={formatPence(data.custody.totalHeldPence)} />
              <StatCard
                label="Oldest holding"
                value={`${data.custody.oldestHeldDays}d`}
                detail={`warns past ${data.custody.warningThresholdDays}d`}
                warn={data.custody.status === 'warning'}
              />
            </StatGrid>
            {data.custody.status === 'warning' && (
              <p className="text-ui-xs text-crimson mt-3">
                Holding duration exceeds the warning threshold. If held funds regularly persist this
                long, consult a financial services lawyer about PSR/EMR obligations.
              </p>
            )}
          </StatSection>

          <p className="text-ui-xs text-grey-600 max-w-article">
            These thresholds are indicative and stored as config dials. Consult an accountant for
            tax advice and a financial services lawyer for regulatory obligations.
          </p>
        </>
      )}
    </AdminShell>
  )
}
