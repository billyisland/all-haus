'use client'

// =============================================================================
// SettlementReceipt — what one card charge covered (Reader Terms 5.2).
//
// "We will give you a receipt for every charge, itemising the pieces it covers,
// the Writers concerned and what you paid for each." The ledger's settlement row
// said "Balance settled £8.00" and linked to nothing; the Reader learned of the
// charge from their bank and had no way to find out what it was for.
//
// IT OPENS IN PLACE, NOT ON A PAGE. The ledger is a Glasshouse overlay, so a
// link out of it is the escape the overlay rules exist to stop — and a receipt
// is an aside from the row it belongs to, not a destination. The row expands.
//
// THE WRITER IS NAMED ON EVERY LINE, because the Writer is who the reader bought
// from (Reader Terms 1.1: the contract is with the Writer; all.haus concludes
// the sale as their disclosed agent). A receipt listing titles and a total with
// only the platform named says the opposite.
//
// A £0.00 LINE SAYS WHY IT IS £0.00. The free allowance is a gift — a read it
// covered cost the reader nothing — and a bare "£0.00" on a receipt reads as
// something having gone wrong.
//
// AND WHERE THE ITEMS DO NOT SUM TO THE CHARGE, THE RECEIPT SAYS SO IN WORDS.
// The read↔settlement attribution is approximate by design (a read that lands
// between a charge being reserved and its confirmation is listed here but
// collected by the next charge). Printing two totals that differ and leaving the
// reader to reconcile them would be worse than printing neither.
// =============================================================================

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { request } from '../../lib/api/client'
import {
  pounds,
  DISCHARGE_SENTENCE,
  RECEIPT_UNAVAILABLE,
  RECEIPT_HEADING,
  RECEIPT_ITEMISED_ELSEWHERE,
  RECEIPT_FREE_ALLOWANCE,
  RECEIPT_REVERSED,
  receiptCarriedSentence,
  receiptShortfallSentence,
} from '../../content/ledger'

interface ReceiptItem {
  kind: 'read' | 'subscription'
  description: string
  writerName: string
  writerUsername: string
  pricePence: number
  link: string | null
  at: string
}

interface Receipt {
  settlementId: string
  settledAt: string
  amountPence: number
  triggerType: string
  reversedAt: string | null
  items: ReceiptItem[]
  itemisedPence: number
  unitemisedPence: number
}

// Reader Terms 1.4. The sentence lives in `content/ledger.ts` beside the rest
// of the receipt's words, which the plain register reads too.
export { DISCHARGE_SENTENCE }

export function SettlementReceipt({ settlementId }: { settlementId: string }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const data = await request<Receipt>(`/my/receipts/${settlementId}`)
        if (!live) return
        setReceipt(data)
        setState('ready')
      } catch {
        // An outage renders as an outage, never as an empty state: "this charge
        // covered nothing" is a different and alarming claim.
        if (live) setState('failed')
      }
    })()
    return () => { live = false }
  }, [settlementId])

  if (state === 'loading') {
    return <p className="text-ui-xs text-grey-400">Loading…</p>
  }

  if (state === 'failed' || !receipt) {
    return (
      <p className="text-ui-xs text-grey-400">
        {RECEIPT_UNAVAILABLE}
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <p className="label-ui text-grey-600">
        {RECEIPT_HEADING}
      </p>

      {receipt.items.length === 0 ? (
        <p className="text-ui-xs text-grey-400">
          {RECEIPT_ITEMISED_ELSEWHERE}
        </p>
      ) : (
        <ul className="space-y-2">
          {receipt.items.map((item, i) => (
            <li key={`${item.kind}-${i}`} className="flex items-baseline justify-between gap-4">
              <span className="text-ui-xs text-black">
                {item.link ? (
                  <Link href={item.link} className="hover:opacity-70">{item.description}</Link>
                ) : (
                  item.description
                )}
                {' '}
                <span className="text-grey-400">
                  — {item.writerUsername ? (
                    <Link href={`/${item.writerUsername}`} className="hover:opacity-70">{item.writerName}</Link>
                  ) : item.writerName}
                </span>
              </span>
              <span className="whitespace-nowrap font-mono text-mono-xs tabular-nums text-black">
                {item.pricePence === 0 ? (
                  <>£0.00 <span className="text-grey-400">{RECEIPT_FREE_ALLOWANCE}</span></>
                ) : (
                  pounds(item.pricePence)
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* The gap, by SIGN (§0z item 19b) — the same two sentences as the
          email, pinned by settlement-receipt-copy.test.ts. A positive gap is
          not reading at all; the old sentence promised a receipt that never
          came. */}
      {receipt.unitemisedPence > 0 && (
        <p className="text-ui-xs text-grey-400">
          {receiptCarriedSentence(receipt.unitemisedPence)}
        </p>
      )}
      {receipt.unitemisedPence < 0 && (
        <p className="text-ui-xs text-grey-400">
          {receiptShortfallSentence(receipt.unitemisedPence)}
        </p>
      )}

      {receipt.reversedAt && (
        <p className="text-ui-xs text-crimson-dark">
          {RECEIPT_REVERSED}
        </p>
      )}

      <p className="text-ui-xs text-grey-400">{DISCHARGE_SENTENCE}</p>
    </div>
  )
}
