'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { publications as pubApi } from '../../lib/api'
import { useReader } from '../../stores/reader'
import { useDashboardOverlay } from '../../stores/dashboardOverlay'
import { useEditorOverlay } from '../../stores/editorOverlay'

interface Props {
  publicationId: string
  publicationSlug: string
  canPublish: boolean
  canEditOthers: boolean
  inOverlay?: boolean
}

export function PublicationArticlesTab({ publicationId, publicationSlug, canPublish, canEditOthers, inOverlay = false }: Props) {
  const [articles, setArticles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('')

  useEffect(() => {
    setLoading(true)
    pubApi.listArticles(publicationId, { status: statusFilter || undefined })
      .then(res => setArticles(res.articles))
      .catch(() => setError('Failed to load articles.'))
      .finally(() => setLoading(false))
  }, [publicationId, statusFilter])

  async function handlePublish(articleId: string) {
    try {
      await pubApi.publishArticle(publicationId, articleId)
      setArticles(prev => prev.map(a => a.id === articleId ? { ...a, status: 'published' } : a))
    } catch { setError('Failed to publish.') }
  }

  async function handleUnpublish(articleId: string) {
    try {
      await pubApi.unpublishArticle(publicationId, articleId)
      setArticles(prev => prev.map(a => a.id === articleId ? { ...a, status: 'unpublished' } : a))
    } catch { setError('Failed to unpublish.') }
  }

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
  if (error) return <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black">{error}</div>

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        {['', 'submitted', 'published', 'unpublished'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`tab-pill ${statusFilter === s ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {articles.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400 mb-4">No articles found.</p>
          {inOverlay ? (
            <button type="button" onClick={() => { useDashboardOverlay.getState().close(); useEditorOverlay.getState().open({ publicationSlug }) }} className="btn-text underline underline-offset-4">
              Write an article
            </button>
          ) : (
            <Link href={`/write?pub=${publicationSlug}`} className="btn-text underline underline-offset-4">
              Write an article
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto bg-glasshouse-well">
          <table className="w-full text-ui-xs">
            <thead>
              <tr className="border-b-2 border-grey-200">
                <th className="px-4 py-3 text-left label-ui text-grey-400">Title</th>
                <th className="px-4 py-3 text-left label-ui text-grey-400">Author</th>
                <th className="px-4 py-3 text-left label-ui text-grey-400">Status</th>
                <th className="px-4 py-3 text-left label-ui text-grey-400">Date</th>
                {canEditOthers && <th className="px-4 py-3 text-right label-ui text-grey-400">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {articles.map(a => (
                <tr key={a.id} className="border-b-2 border-grey-200 last:border-b-0">
                  <td className="px-4 py-3">
                    {inOverlay && a.d_tag ? (
                      <button
                        type="button"
                        onClick={() => { useDashboardOverlay.getState().close(); useReader.getState().openNative(a.d_tag) }}
                        className="text-black hover:opacity-70 text-left"
                      >
                        {a.title}
                      </button>
                    ) : (
                      <Link href={a.d_tag ? `/article/${a.d_tag}` : '#'} className="text-black hover:opacity-70">
                        {a.title}
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-grey-400">
                    {a.author_display_name || a.author_username}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-ui-xs ${a.status === 'published' ? 'text-black' : a.status === 'submitted' ? 'text-crimson' : 'text-grey-300'}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-grey-400">
                    {a.published_at ? new Date(a.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '--'}
                  </td>
                  {canEditOthers && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {a.status === 'submitted' && canPublish && (
                          <button onClick={() => handlePublish(a.id)} className="text-crimson hover:text-crimson-dark">
                            Publish
                          </button>
                        )}
                        {a.status === 'published' && canPublish && (
                          <button onClick={() => handleUnpublish(a.id)} className="text-grey-300 hover:text-black">
                            Unpublish
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
