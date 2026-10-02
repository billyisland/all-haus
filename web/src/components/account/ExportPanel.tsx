'use client'

import { useState } from 'react'
import {
  EXPORT_INTRO,
  EXPORT_RECEIPTS_TITLE, EXPORT_RECEIPTS_DESCRIPTION,
  EXPORT_ACCOUNT_TITLE, EXPORT_ACCOUNT_DESCRIPTION,
  EXPORT_DOWNLOADED, EXPORT_STEP_UP_SENT, EXPORT_EXPORTING, EXPORT_FAILED,
  exportFailedStatus,
} from '../../content/settings'
import { failureSentence } from '../../lib/api/client'

// =============================================================================
// The two exports, and only one of them is a download.
//
// "Portable receipts" is an ordinary fetch. "Full account export" carries the
// root Nostr secret key — the identity itself, unrotatable — so since
// MIRROR-AUDIT §2.6 it needs a mailed confirmation as well as the session: the
// gateway answers `step_up_required`, this asks for the email, and the link in
// it lands on `/account/export`, which is where the file actually comes down.
//
// A CONFIRMATION IS NOT A REFUSAL, so `step_up_required` is not rendered as an
// error. It is the normal path for this button, and the copy says what is
// happening and where to look next.
//
// INLINE IN THE SETTINGS SECTION, NOT A MODAL OVER IT (CA-E9, 2026-09-29).
// This was `ExportModal`: a hand-rolled full-viewport scrim at a raw z of 100
// and a centred white pane floated over the settings Glasshouse, with its own
// Escape shield and focus trap, and a by-name exemption in the one-close-
// affordance test because the disc-X could not target it. A Glasshouse is
// one-at-a-time, so "make it a Glasshouse" would have meant superseding the
// settings pane for two buttons; and nothing here is modal — it is two rows
// under the section whose button opens it. So the button reveals the rows in
// place, the scrim and the raw z are gone, and the exemption with them.
//
// AND A 429 IS NOT A CONFIRMATION. The step-up request's response was never
// read before `EXPORT_STEP_UP_SENT` rendered, so a member past the five-an-hour
// limit was told an email was on its way. The gateway answers `200 {ok:true}`
// uniformly for anything it deliberately will not say (no address, a send that
// failed — the anti-leak, `export.ts`), so `res.ok` catches exactly the two
// things that are not that: the rate limit and a 5xx.
// =============================================================================

type ExportType = 'receipts' | 'account'

export function ExportPanel() {
  const [exporting, setExporting] = useState<ExportType | null>(null)
  const [downloaded, setDownloaded] = useState<Set<ExportType>>(new Set())
  const [errors, setErrors] = useState<Map<ExportType, string>>(new Map())
  const [confirmationSent, setConfirmationSent] = useState(false)

  async function handleExport(type: ExportType) {
    setExporting(type)
    setErrors(prev => { const next = new Map(prev); next.delete(type); return next })
    try {
      const endpoint = type === 'receipts' ? '/api/v1/receipts/export' : '/api/v1/account/export'
      const res = await fetch(endpoint, { credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string; message?: string } | null
        // The step-up, which is the expected answer for the account bundle and
        // not a failure: ask for the email and say so. The request endpoint
        // answers the same way whatever it finds, so there is nothing about
        // the account to leak back — but a refusal to SEND (the rate limit, a
        // fault) is not a send, and is said as its own thing.
        if (body?.error === 'step_up_required') {
          const sent = await fetch('/api/v1/account/export/request', {
            method: 'POST',
            credentials: 'include',
          })
          if (!sent.ok) {
            const sentBody = await sent.json().catch(() => null) as { error?: string; message?: string } | null
            throw new Error(sentBody?.message ?? sentBody?.error ?? exportFailedStatus(sent.status))
          }
          setConfirmationSent(true)
          return
        }
        throw new Error(body?.message ?? body?.error ?? exportFailedStatus(res.status))
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = type === 'receipts' ? 'platform-receipts.json' : 'platform-account-export.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDownloaded(prev => new Set(prev).add(type))
    } catch (err) {
      const message = failureSentence(err, EXPORT_FAILED)
      setErrors(prev => new Map(prev).set(type, message))
    } finally {
      setExporting(null)
    }
  }

  return (
    <div>
      <p className="text-ui-sm font-sans text-grey-600 mb-4">
        {EXPORT_INTRO}
      </p>

      <div className="space-y-3">
        <div>
          <button
            onClick={() => handleExport('receipts')}
            disabled={exporting !== null}
            className="w-full text-left px-4 py-3 bg-glasshouse-well hover:bg-grey-200 transition-colors disabled:opacity-50"
          >
            <p className="text-ui-sm font-sans font-medium text-black">{EXPORT_RECEIPTS_TITLE}</p>
            <p className="text-ui-xs font-sans text-grey-400 mt-0.5">{EXPORT_RECEIPTS_DESCRIPTION}</p>
          </button>
          {downloaded.has('receipts') && (
            <p className="text-ui-xs font-sans text-green-600 mt-1 px-4">{EXPORT_DOWNLOADED}</p>
          )}
          {errors.has('receipts') && (
            <p className="text-ui-xs font-sans text-crimson mt-1 px-4">{errors.get('receipts')}</p>
          )}
        </div>

        <div>
          <button
            onClick={() => handleExport('account')}
            disabled={exporting !== null}
            className="w-full text-left px-4 py-3 bg-glasshouse-well hover:bg-grey-200 transition-colors disabled:opacity-50"
          >
            <p className="text-ui-sm font-sans font-medium text-black">{EXPORT_ACCOUNT_TITLE}</p>
            <p className="text-ui-xs font-sans text-grey-400 mt-0.5">{EXPORT_ACCOUNT_DESCRIPTION}</p>
          </button>
          {downloaded.has('account') && (
            <p className="text-ui-xs font-sans text-green-600 mt-1 px-4">{EXPORT_DOWNLOADED}</p>
          )}
          {confirmationSent && (
            <p className="text-ui-sm font-sans text-grey-600 mt-2 px-4">
              {EXPORT_STEP_UP_SENT}
            </p>
          )}
          {errors.has('account') && (
            <p className="text-ui-xs font-sans text-crimson mt-1 px-4">{errors.get('account')}</p>
          )}
        </div>
      </div>

      {exporting && (
        <span className="text-ui-xs font-sans text-grey-300 block mt-3">{EXPORT_EXPORTING}</span>
      )}
    </div>
  )
}
