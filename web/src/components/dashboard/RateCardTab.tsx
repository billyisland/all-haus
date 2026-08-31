'use client'

import React, { useState, useEffect } from 'react'
import { publications as pubApi } from '../../lib/api'

interface Props {
  publicationId: string
}

export function RateCardTab({ publicationId }: Props) {
  const [subPrice, setSubPrice] = useState('')
  const [annualDiscount, setAnnualDiscount] = useState('')
  const [defaultArticlePrice, setDefaultArticlePrice] = useState('')
  const [articlePriceMode, setArticlePriceMode] = useState<'per_article' | 'per_1000_words'>('per_article')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    pubApi.getRateCard(publicationId)
      .then(rc => {
        setSubPrice((rc.subscriptionPricePence / 100).toFixed(2))
        setAnnualDiscount(String(rc.annualDiscountPct))
        setDefaultArticlePrice((rc.defaultArticlePricePence / 100).toFixed(2))
        setArticlePriceMode(rc.articlePriceMode === 'per_1000_words' ? 'per_1000_words' : 'per_article')
      })
      .catch(() => setMsg('Failed to load rate card.'))
      .finally(() => setLoading(false))
  }, [publicationId])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const subPence = Math.round(parseFloat(subPrice) * 100)
    const discount = parseInt(annualDiscount, 10)
    const artPence = Math.round(parseFloat(defaultArticlePrice) * 100)
    if (isNaN(subPence) || subPence < 0) { setMsg('Enter a valid subscription price.'); return }
    if (isNaN(discount) || discount < 0 || discount > 100) { setMsg('Discount must be 0\u2013100%.'); return }
    if (isNaN(artPence) || artPence < 0) { setMsg('Enter a valid article price.'); return }

    setSaving(true); setMsg(null)
    try {
      await pubApi.updateRateCard(publicationId, {
        subscriptionPricePence: subPence,
        annualDiscountPct: discount,
        defaultArticlePricePence: artPence,
        articlePriceMode,
      })
      setMsg('Rate card updated.')
    } catch { setMsg('Failed to save.') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="h-40 animate-pulse bg-glasshouse-well" />

  const monthlyPence = Math.round(parseFloat(subPrice || '0') * 100)
  const discountPct = parseInt(annualDiscount || '0', 10)
  const annualPence = Math.round(monthlyPence * 12 * (1 - discountPct / 100))

  return (
    <div className="space-y-8">
      <div className="bg-glasshouse-well px-6 py-5">
        <p className="label-ui text-grey-400 mb-4">Subscription pricing</p>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-ui-sm font-sans text-grey-400">£</span>
            <input
              type="number" step="0.01" min="0" value={subPrice}
              onChange={e => setSubPrice(e.target.value)}
              className="w-28 bg-grey-100 px-3 py-1.5 text-ui-sm font-sans text-black placeholder-grey-300"
              placeholder="8.00"
            />
            <span className="text-ui-xs font-sans text-grey-300">/month</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-ui-sm font-sans text-grey-400 w-[13px]">%</span>
            <input
              type="number" min="0" max="100" value={annualDiscount}
              onChange={e => setAnnualDiscount(e.target.value)}
              className="w-28 bg-grey-100 px-3 py-1.5 text-ui-sm font-sans text-black placeholder-grey-300"
              placeholder="15"
            />
            <span className="text-ui-xs font-sans text-grey-300">annual discount</span>
          </div>
          {monthlyPence > 0 && (
            <p className="text-ui-xs font-sans text-grey-400">
              Readers pay £{subPrice}/mo or £{(annualPence / 100).toFixed(2)}/year{discountPct > 0 ? ` (save ${discountPct}%)` : ''}
            </p>
          )}

          <div className="pt-6">
            <p className="label-ui text-grey-400 mb-3">Default per-article price</p>
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => setArticlePriceMode('per_article')}
                className={`px-3 py-1.5 text-ui-xs font-sans transition-colors ${
                  articlePriceMode === 'per_article' ? 'bg-black text-white' : 'bg-grey-100 text-black hover:bg-grey-200/60'
                }`}
              >
                Per article
              </button>
              <button
                type="button"
                onClick={() => setArticlePriceMode('per_1000_words')}
                className={`px-3 py-1.5 text-ui-xs font-sans transition-colors ${
                  articlePriceMode === 'per_1000_words' ? 'bg-black text-white' : 'bg-grey-100 text-black hover:bg-grey-200/60'
                }`}
              >
                Per 1,000 words
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-ui-sm font-sans text-grey-400">£</span>
              <input
                type="number" step="0.01" min="0" value={defaultArticlePrice}
                onChange={e => setDefaultArticlePrice(e.target.value)}
                className="w-28 bg-grey-100 px-3 py-1.5 text-ui-sm font-sans text-black placeholder-grey-300"
                placeholder={articlePriceMode === 'per_1000_words' ? '0.10' : '0.20'}
              />
              <span className="text-ui-xs font-sans text-grey-300">
                {articlePriceMode === 'per_1000_words' ? 'per 1,000 words' : 'per read'}
              </span>
            </div>
            {articlePriceMode === 'per_1000_words' && (
              <p className="text-ui-xs font-sans text-grey-400 mt-2">
                e.g. a 3,800-word article would cost £{(parseFloat(defaultArticlePrice || '0') * 3).toFixed(2)}
              </p>
            )}
            <p className="text-ui-xs font-sans text-grey-300 mt-2">
              Individual articles can override this in the editor.
            </p>
          </div>

          <button type="submit" disabled={saving} className="btn text-sm disabled:opacity-50">
            {saving ? 'Saving\u2026' : 'Save'}
          </button>
        </form>
        {msg && <p className="text-ui-xs text-grey-600 mt-2">{msg}</p>}
      </div>
    </div>
  )
}
