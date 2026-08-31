'use client'

import { useState } from 'react'

type ExportType = 'receipts' | 'account'

export function ExportModal({ onClose }: { onClose: () => void }) {
  const [exporting, setExporting] = useState<ExportType | null>(null)
  const [downloaded, setDownloaded] = useState<Set<ExportType>>(new Set())
  const [errors, setErrors] = useState<Map<ExportType, string>>(new Map())

  async function handleExport(type: ExportType) {
    setExporting(type)
    setErrors(prev => { const next = new Map(prev); next.delete(type); return next })
    try {
      const endpoint = type === 'receipts' ? '/api/v1/receipts/export' : '/api/v1/account/export'
      const res = await fetch(endpoint, { credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `Export failed (${res.status})`)
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
      const message = err instanceof Error ? err.message : 'Export failed. Please try again.'
      setErrors(prev => new Map(prev).set(type, message))
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20">
      <div className="relative bg-white w-full max-w-md mx-4 px-6 py-6 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-grey-400 hover:text-black text-lg leading-none"
        >
          ✕
        </button>
        <p className="font-serif text-lg font-medium text-black mb-4 pr-8">Export your data</p>

        <p className="text-ui-sm font-sans text-grey-600 mb-6">
          Download your data from all.haus. Receipt tokens are portable across Nostr.
        </p>

        <div className="space-y-3 mb-6">
          <div>
            <button
              onClick={() => handleExport('receipts')}
              disabled={exporting !== null}
              className="w-full text-left px-4 py-3 bg-grey-100 hover:bg-grey-200 transition-colors disabled:opacity-50"
            >
              <p className="text-ui-sm font-sans font-medium text-black">Portable receipts</p>
              <p className="text-ui-xs font-sans text-grey-400 mt-0.5">Cryptographic proof of your paid reads.</p>
            </button>
            {downloaded.has('receipts') && (
              <p className="text-ui-xs font-sans text-green-600 mt-1 px-4">&#10003; Downloaded</p>
            )}
            {errors.has('receipts') && (
              <p className="text-ui-xs font-sans text-red-600 mt-1 px-4">{errors.get('receipts')}</p>
            )}
          </div>

          <div>
            <button
              onClick={() => handleExport('account')}
              disabled={exporting !== null}
              className="w-full text-left px-4 py-3 bg-grey-100 hover:bg-grey-200 transition-colors disabled:opacity-50"
            >
              <p className="text-ui-sm font-sans font-medium text-black">Full account export</p>
              <p className="text-ui-xs font-sans text-grey-400 mt-0.5">Keys, receipts, articles — everything you need to migrate.</p>
            </button>
            {downloaded.has('account') && (
              <p className="text-ui-xs font-sans text-green-600 mt-1 px-4">&#10003; Downloaded</p>
            )}
            {errors.has('account') && (
              <p className="text-ui-xs font-sans text-red-600 mt-1 px-4">{errors.get('account')}</p>
            )}
          </div>
        </div>

        {exporting && (
          <span className="text-ui-xs font-sans text-grey-300">Exporting…</span>
        )}
      </div>
    </div>
  )
}
