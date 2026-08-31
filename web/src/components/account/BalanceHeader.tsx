'use client'

interface BalanceHeaderProps {
  balancePence: number
  freeAllowanceRemainingPence: number
  freeAllowanceTotalPence: number
  // Upstream Edges Phase 3: earnings reserved for in-flight tributes. Rendered
  // only when > 0 (the tribute money flow is live and this author has a pending
  // share) — "reserved, pending redirect", never "paid to X"; the wording is a
  // constraint, not a preference (docs/adr/LEGAL-BRAKES.md).
  reservedForTributesPence?: number
}

export function BalanceHeader({ balancePence, freeAllowanceRemainingPence, freeAllowanceTotalPence, reservedForTributesPence = 0 }: BalanceHeaderProps) {
  const isPositive = balancePence >= 0
  const allowancePct = freeAllowanceTotalPence > 0
    ? Math.round((freeAllowanceRemainingPence / freeAllowanceTotalPence) * 100)
    : 0

  return (
    <div data-explain="ledger.balance" className="bg-glasshouse-well px-6 py-8 mb-8">
      <p className="label-ui text-grey-300 mb-2">Net balance</p>
      <p className={`font-serif text-[40px] font-light tracking-tight ${isPositive ? 'text-black' : 'text-crimson'}`}>
        {!isPositive && '−'}£{(Math.abs(balancePence) / 100).toFixed(2)}
      </p>
      {/* Sign convention: net = earnings − tab, so positive means the platform
          owes the reader (in credit) and negative means an outstanding tab,
          which is the case that settles from the card at the threshold. Mirrors
          the ledger.balance Explain caption. */}
      <p className="text-ui-xs text-grey-400 mt-1">
        {balancePence === 0
          ? 'Settled — nothing owed either way'
          : isPositive
            ? 'In credit — this is yours'
            : 'Outstanding balance — settles from your card once the tab reaches its threshold'}
      </p>

      {freeAllowanceTotalPence > 0 && (
        <div data-explain="ledger.allowance" className="mt-6">
          <div className="flex items-center justify-between mb-1.5">
            <p className="label-ui text-grey-300">Free allowance</p>
            <p className="font-mono text-mono-xs text-grey-400">
              £{(freeAllowanceRemainingPence / 100).toFixed(2)} of £{(freeAllowanceTotalPence / 100).toFixed(2)}
            </p>
          </div>
          <div className="h-1.5 bg-grey-200 w-full">
            <div className="h-full bg-crimson transition-all" style={{ width: `${allowancePct}%` }} />
          </div>
        </div>
      )}

      {reservedForTributesPence > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1">
            <p className="label-ui text-grey-600">Reserved for tributes</p>
            <p className="font-mono text-mono-xs text-grey-600">
              £{(reservedForTributesPence / 100).toFixed(2)}
            </p>
          </div>
          <p className="text-ui-xs text-grey-600">
            Reserved from your earnings while tributes you’ve offered are in flight. Unclaimed offers return to you; once a source accepts, their share is redirected to them.
          </p>
        </div>
      )}
    </div>
  )
}
