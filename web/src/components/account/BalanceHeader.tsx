'use client'

import {
  pounds,
  LEDGER_OWE_LABEL,
  LEDGER_TAB_CLEAR,
  LEDGER_TAB_OWING,
  LEDGER_OWED_LABEL,
  LEDGER_OWED_HELP,
  LEDGER_REFUND_LABEL,
  LEDGER_REFUND_HELP,
  LEDGER_ALLOWANCE_LABEL,
  ledgerAllowanceFigure,
  LEDGER_READERS_PAID_LABEL,
  LEDGER_FEE_LABEL,
  LEDGER_FEE_HELP,
  LEDGER_ALLOWANCE_GIVEN_LABEL,
  ledgerAllowanceGivenSentence,
} from '../../content/ledger'

// =============================================================================
// BalanceHeader — TWO FIGURES, NEVER A NET.
//
// Reader Terms 11.1: "Your reading and your writing are separate. Money you
// earn as a Writer is not set off against what you owe as a Reader, and vice
// versa." This header used to render exactly that set-off — one "Net balance"
// figure computed as `pendingTransfer − tabBalance` — so a writer owed £40 who
// had read £3 was told they were owed £37, and a reader £3 down with £3 of
// pending earnings was told they were square. Neither is true of either
// account, and the platform will not in fact pay one out of the other.
//
// Reader Terms 4.3: where a billing error leaves a reader in credit, "we will
// refund that amount to the payment method it came from. We will not show it to
// you as a balance or let you spend it." Both halves are structural now. It
// CANNOT be spent, because a reading tab no longer holds it — migration 206
// moves an over-collection out into a payable the moment it would exist, so
// `tabBalancePence` is always a debt or nothing. And it is not shown as a
// balance, because it is not on the tab's scale at all: it is its own line, in
// the clause's own words, naming the refund.
//
// It is still SHOWN, and that is deliberate. Making the money invisible to the
// person owed it would satisfy "not as a balance" by satisfying nothing —
// 4.3 promises the money goes back, and a promise nobody is told about is not
// one they can hold us to. So a reader can owe us for today's reading AND be
// owed a refund from last month's billing error, and sees both, unnetted.
// The old header did the opposite of all of this: "In credit — this is yours",
// which offers a wallet the platform does not have and the text says it will
// not give. Why the clause reads that way is in `docs/adr/LEGAL-BRAKES.md`;
// the incident behind a credit has a runbook at
// `docs/runbooks/reader-tab-credit.md`.
//
// So: what you owe and what you are owed are two labelled figures that never
// meet, and a negative tab is displaced entirely by the refund statement.
// =============================================================================

interface BalanceHeaderProps {
  /** The reading tab. A debt or nothing: it can no longer go negative. */
  tabBalancePence: number
  /** What the platform over-collected and owes back, POSITIVE and never netted
   * against the tab. Its own line when it is non-zero, absent when it is not —
   * most readers never see one, and a permanent "Refund due £0.00" would invite
   * exactly the balance-watching 4.3 refuses. */
  refundDuePence: number
  /** Writer money earned and not yet sent (`pendingTransferPence`), never
   * lifetime earnings. A pure reader has 0 and sees no second figure. */
  pendingEarningsPence: number
  freeAllowanceRemainingPence: number
  freeAllowanceTotalPence: number
  // Upstream Edges Phase 3: earnings reserved for in-flight tributes. Rendered
  // only when > 0 (the tribute money flow is live and this author has a pending
  // share) — "reserved, pending redirect", never "paid to X"; the wording is a
  // constraint, not a preference (docs/adr/LEGAL-BRAKES.md).
  reservedForTributesPence?: number
  // L5.4 / audit 3.11: what readers paid the Writer, and what all.haus took for
  // acting as their agent. The Writer is the seller (Reader Terms 1.1), so the
  // gross is THEIR figure and our cut is a deduction from it — a page showing
  // only the net leaves the one number an agent owes its principal off it.
  // Lifetime, matching the earnings the fee was taken from; 0 for a reader.
  grossEarnedPence?: number
  platformFeePence?: number
  // A2 / Writer 11.1: reading the Writer gave away. The free allowance is a
  // price waiver the WRITER authorises and bears, and on which we take no fee —
  // so they are told, in a figure of its own that is never added to earnings
  // (this money was never collected from anybody) and never subtracted from
  // them (the reader would not have paid it).
  allowanceCoveredPence?: number
  allowanceReadCount?: number
}


export function BalanceHeader({
  tabBalancePence,
  refundDuePence,
  pendingEarningsPence,
  freeAllowanceRemainingPence,
  freeAllowanceTotalPence,
  reservedForTributesPence = 0,
  grossEarnedPence = 0,
  platformFeePence = 0,
  allowanceCoveredPence = 0,
  allowanceReadCount = 0,
}: BalanceHeaderProps) {
  const allowancePct = freeAllowanceTotalPence > 0
    ? Math.round((freeAllowanceRemainingPence / freeAllowanceTotalPence) * 100)
    : 0

  // The second figure is a writer's, and a reader has no writing. Rendering
  // "You are owed £0.00" on every reader's ledger states nothing and invites
  // exactly the set-off arithmetic the two figures exist to refuse.
  const showEarned = pendingEarningsPence > 0
  const showRefund = refundDuePence > 0
  // A writer who has earned nothing has no gross to break down, and a reader
  // never will — "£0.00 gross, £0.00 fee" states nothing on either page.
  const showFeeBreakdown = grossEarnedPence > 0
  // Same test on the gift: a Writer nobody has read on an allowance has not
  // given anything away, and a standing "£0.00 given" would invite them to
  // watch a number that only ever means one thing when it moves.
  const showAllowanceGiven = allowanceCoveredPence > 0

  return (
    <div data-explain="ledger.balance" className="bg-glasshouse-well px-6 py-8 mb-8">
      <div className={showEarned ? 'grid grid-cols-1 sm:grid-cols-2 gap-8' : ''}>
        <div>
          <p className="label-ui text-grey-300 mb-2">{LEDGER_OWE_LABEL}</p>
          <p className="font-serif text-[40px] font-light tracking-tight text-crimson">
            {pounds(tabBalancePence)}
          </p>
          <p className="text-ui-xs text-grey-400 mt-1">
            {tabBalancePence === 0 ? LEDGER_TAB_CLEAR : LEDGER_TAB_OWING}
          </p>
        </div>

        {showEarned && (
          <div>
            <p className="label-ui text-grey-300 mb-2">{LEDGER_OWED_LABEL}</p>
            <p className="font-serif text-[40px] font-light tracking-tight text-black">
              {pounds(pendingEarningsPence)}
            </p>
            <p className="text-ui-xs text-grey-400 mt-1">
              {LEDGER_OWED_HELP}
            </p>
          </div>
        )}
      </div>

      {/* Reader Terms 4.3, in its own words, on its own line. Not a balance, not
          spendable, and going back the way it came. */}
      {showRefund && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1">
            <p className="label-ui text-grey-300">{LEDGER_REFUND_LABEL}</p>
            <p className="font-mono text-mono-xs text-grey-400">{pounds(refundDuePence)}</p>
          </div>
          <p className="text-ui-xs text-grey-400">
            {LEDGER_REFUND_HELP}
          </p>
        </div>
      )}

      {freeAllowanceTotalPence > 0 && (
        <div data-explain="ledger.allowance" className="mt-6">
          <div className="flex items-center justify-between mb-1.5">
            <p className="label-ui text-grey-300">{LEDGER_ALLOWANCE_LABEL}</p>
            <p className="font-mono text-mono-xs text-grey-400">
              {ledgerAllowanceFigure(freeAllowanceRemainingPence, freeAllowanceTotalPence)}
            </p>
          </div>
          <div className="h-1.5 bg-grey-200 w-full">
            <div className="h-full bg-crimson transition-all" style={{ width: `${allowancePct}%` }} />
          </div>
        </div>
      )}

      {/* What readers paid and what we took (audit 3.11). Beside the earnings
          figures, never inside them: the two above are what is OWED and what
          has been SENT, and these are the history the fee came out of. */}
      {showFeeBreakdown && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1">
            <p className="label-ui text-grey-300">{LEDGER_READERS_PAID_LABEL}</p>
            <p className="font-mono text-mono-xs text-grey-400">{pounds(grossEarnedPence)}</p>
          </div>
          <div className="flex items-center justify-between mb-1">
            <p className="label-ui text-grey-300">{LEDGER_FEE_LABEL}</p>
            <p className="font-mono text-mono-xs text-grey-400">−{pounds(platformFeePence)}</p>
          </div>
          <p className="text-ui-xs text-grey-400">
            {LEDGER_FEE_HELP}
          </p>
        </div>
      )}

      {/* The gift, in the Writer's own accounts (A2 / Writer 11.1). */}
      {showAllowanceGiven && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1">
            <p className="label-ui text-grey-300">{LEDGER_ALLOWANCE_GIVEN_LABEL}</p>
            <p className="font-mono text-mono-xs text-grey-400">{pounds(allowanceCoveredPence)}</p>
          </div>
          <p className="text-ui-xs text-grey-400">
            {ledgerAllowanceGivenSentence(allowanceReadCount)}
          </p>
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
