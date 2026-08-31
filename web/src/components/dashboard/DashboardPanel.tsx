'use client'

// =============================================================================
// DashboardPanel — the writer/publication dashboard body. It now renders inside
// the workspace Glasshouse overlay (DashboardOverlay); the /dashboard route is a
// redirect shim into that overlay. The component keeps a page-capable mode
// (`inOverlay=false`: PageShell-less body, URL sync, auth redirect) so it can be
// hosted standalone again if needed. When `inOverlay` is set, the panel does not
// touch the URL (the workspace owns it) and skips the auth redirect (the overlay
// only mounts for authenticated users); initial tab/context arrive as props
// instead of from the query string.
// =============================================================================

import React, { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { myArticles, account as accountApi, auth, publications as pubApi, type MyArticle, type PublicationMembership } from '../../lib/api'
import { loadDrafts, deleteDraft, scheduleDraft, unscheduleDraft } from '../../lib/drafts'
import { KIND_DELETION } from '../../lib/ndk'
import { signAndPublish } from '../../lib/sign'
import { GiftLinksPanel } from './GiftLinksPanel'
import { ProposalsTab } from './ProposalsTab'
import { PublicationArticlesTab } from './PublicationArticlesTab'
import { MembersTab } from './MembersTab'
import { PublicationSettingsTab } from './PublicationSettingsTab'
import { RateCardTab } from './RateCardTab'
import { PayrollTab } from './PayrollTab'
import { PublicationEarningsTab } from './PublicationEarningsTab'
import { SubscribersTab } from './SubscribersTab'
import { AnalyticsTab } from './AnalyticsTab'
import { traffologyEnabled, publicationsEnabled } from '../../lib/featureFlags'
import { useDashboardOverlay } from '../../stores/dashboardOverlay'
import { useLedgerOverlay } from '../../stores/ledgerOverlay'
import { useReader } from '../../stores/reader'
import { useEditorOverlay } from '../../stores/editorOverlay'

type DashboardTab = 'articles' | 'subscribers' | 'proposals' | 'pricing' | 'analytics'

// Backwards-compatible aliases for old URLs / deep links
const tabAliases: Record<string, DashboardTab> = {
  drafts: 'articles',
  drives: 'proposals',
  commissions: 'proposals',
  offers: 'proposals',
  settings: 'pricing',
}
type PubDashboardTab = 'articles' | 'members' | 'settings' | 'rate-card' | 'payroll' | 'earnings' | 'analytics'

export function DashboardPanel({
  inOverlay = false,
  initialTab = null,
  initialContext = null,
}: {
  inOverlay?: boolean
  initialTab?: string | null
  initialContext?: string | null
}) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawTab = inOverlay ? initialTab : searchParams.get('tab')
  const contextSlug = inOverlay ? initialContext : searchParams.get('context')
  const resolvedTab = rawTab ? (tabAliases[rawTab] ?? rawTab) : null
  const initialResolvedTab: DashboardTab = (resolvedTab as DashboardTab) || 'articles'
  const [activeTab, setActiveTab] = useState<DashboardTab>(initialResolvedTab)
  const [pubTab, setPubTab] = useState<PubDashboardTab>((rawTab as PubDashboardTab) || 'articles')
  const [pubMemberships, setPubMemberships] = useState<PublicationMembership[]>([])
  const [selectedContext, setSelectedContext] = useState<string | null>(contextSlug)
  const [showNewPub, setShowNewPub] = useState(false)
  const [newPubName, setNewPubName] = useState('')
  const [newPubSlug, setNewPubSlug] = useState('')
  const [newPubSaving, setNewPubSaving] = useState(false)
  const [newPubError, setNewPubError] = useState<string | null>(null)

  useEffect(() => { if (!inOverlay && !loading && !user) router.push('/auth?mode=login') }, [inOverlay, user, loading, router])

  // Load publication memberships. Skipped entirely while publications are
  // suspended (lib/featureFlags.ts): the route 404s and the .catch() below would
  // quietly leave the list empty, but a feature that is off by DESIGN should not
  // be reading its emptiness off a failed request — one flag flip and this asks
  // again on its own.
  useEffect(() => {
    if (!user || !publicationsEnabled()) return
    pubApi.myMemberships()
      .then(res => setPubMemberships(res.publications))
      .catch(() => { /* non-critical */ })
  }, [user])

  // Sync tab from URL (for notification deep-linking). Analytics is excluded
  // while traffology is parked so a stale ?tab=analytics deep link can't mount
  // the parked read surface (the pill is already hidden).
  useEffect(() => {
    const tab = rawTab ? (tabAliases[rawTab] ?? rawTab) : null
    const pubTabsAllowed = ['articles', 'members', 'settings', 'rate-card', 'payroll', 'earnings', ...(traffologyEnabled() ? ['analytics'] : [])]
    const personalTabsAllowed = ['articles', 'subscribers', 'proposals', 'pricing', ...(traffologyEnabled() ? ['analytics'] : [])]
    if (selectedContext) {
      if (tab && pubTabsAllowed.includes(tab)) {
        setPubTab(tab as PubDashboardTab)
      }
    } else {
      if (tab && personalTabsAllowed.includes(tab)) {
        setActiveTab(tab)
      }
    }
  }, [rawTab, selectedContext])

  // Sync context from URL
  useEffect(() => {
    setSelectedContext(contextSlug)
  }, [contextSlug])

  // The overlay lives over the workspace, so it never rewrites the address bar.
  function syncUrl(mutate: (url: URL) => void) {
    if (inOverlay) return
    const url = new URL(window.location.href)
    mutate(url)
    window.history.replaceState({}, '', url.toString())
  }

  function switchTab(tab: DashboardTab) {
    setActiveTab(tab)
    syncUrl(url => { url.searchParams.set('tab', tab); url.searchParams.delete('context') })
  }

  function switchPubTab(tab: PubDashboardTab) {
    setPubTab(tab)
    syncUrl(url => { url.searchParams.set('tab', tab) })
  }

  function switchContext(slug: string | null) {
    setSelectedContext(slug)
    if (slug) {
      setPubTab('articles')
    } else {
      setActiveTab('articles')
    }
    syncUrl(url => {
      if (slug) url.searchParams.set('context', slug)
      else url.searchParams.delete('context')
      url.searchParams.set('tab', 'articles')
    })
  }

  async function handleCreatePublication(e: React.FormEvent) {
    e.preventDefault()
    const name = newPubName.trim()
    const slug = newPubSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!name || !slug) return
    setNewPubSaving(true); setNewPubError(null)
    try {
      const result = await pubApi.create({ name, slug })
      const memberships = await pubApi.myMemberships()
      setPubMemberships(memberships.publications)
      setShowNewPub(false); setNewPubName(''); setNewPubSlug('')
      switchContext(result.slug)
    } catch (err: any) {
      setNewPubError(err?.body?.error ?? err?.message ?? 'Failed to create publication.')
    } finally { setNewPubSaving(false) }
  }

  if (loading || !user) return <DashboardSkeleton />

  const selectedPub = pubMemberships.find(p => p.slug === selectedContext)
  const isPublicationContext = !!selectedPub

  // Analytics is the traffology read surface (parked, item 8) — gate the tab so
  // it doesn't hit the dead ingest container / parked tables until an operator
  // flips NEXT_PUBLIC_TRAFFOLOGY_ENABLED on.
  const analyticsTabs: DashboardTab[] = traffologyEnabled() ? ['analytics'] : []
  const personalTabs: DashboardTab[] = ['articles', 'subscribers', 'proposals', 'pricing', ...analyticsTabs]
  const pubTabs: PubDashboardTab[] = [
    'articles', 'members', 'settings',
    ...(selectedPub?.can_manage_finances ? ['rate-card', 'payroll', 'earnings'] as PubDashboardTab[] : []),
    ...(traffologyEnabled() ? ['analytics' as PubDashboardTab] : []),
  ]

  return (
    <>
      {/* Context switcher — the whole row is a publications surface (title
          switcher + "New publication"), so it goes with them rather than
          leaving an empty bar with its bottom margin behind. */}
      {publicationsEnabled() && (
      <div data-explain="dashboard.context" className="flex items-center gap-2 mb-6 text-ui-xs flex-wrap">
        {pubMemberships.length > 0 && (
          <>
            <span className="text-grey-600">Dashboard:</span>
            <button
              onClick={() => switchContext(null)}
              className={`px-2 py-1 ${!isPublicationContext ? 'text-black font-medium' : 'text-grey-600 hover:text-black'}`}
            >
              Personal
            </button>
            {pubMemberships.map(p => (
              <button
                key={p.slug}
                onClick={() => switchContext(p.slug)}
                className={`px-2 py-1 ${selectedContext === p.slug ? 'text-black font-medium' : 'text-grey-600 hover:text-black'}`}
              >
                {p.name}
              </button>
            ))}
            <span className="text-grey-600">|</span>
          </>
        )}
        <button
          onClick={() => setShowNewPub(v => !v)}
          className="px-2 py-1 text-grey-600 hover:text-black transition-colors"
        >
          + New publication
        </button>
      </div>
      )}

      {publicationsEnabled() && showNewPub && (
        <form onSubmit={handleCreatePublication} className="mb-8 bg-glasshouse-well px-6 py-5 max-w-md space-y-4">
          <p className="label-ui text-grey-400">Create a publication</p>
          <div>
            <label htmlFor="pub-name" className="block label-ui text-grey-400 mb-1">Name</label>
            <input
              id="pub-name"
              type="text"
              value={newPubName}
              onChange={(e) => {
                setNewPubName(e.target.value)
                if (!newPubSlug || newPubSlug === newPubName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) {
                  setNewPubSlug(e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
                }
              }}
              maxLength={80}
              placeholder="The Daily Dispatch"
              className="w-full bg-grey-100 px-3 py-2 text-sm text-black placeholder-grey-300 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="pub-slug" className="block label-ui text-grey-400 mb-1">URL slug</label>
            <div className="flex items-center text-sm text-grey-300">
              <span className="mr-1">/pub/</span>
              <input
                id="pub-slug"
                type="text"
                value={newPubSlug}
                onChange={(e) => setNewPubSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                maxLength={60}
                placeholder="daily-dispatch"
                className="flex-1 bg-grey-100 px-3 py-2 text-sm text-black placeholder-grey-300 focus:outline-none"
              />
            </div>
          </div>
          {newPubError && <p className="text-ui-xs text-red-600">{newPubError}</p>}
          <div className="flex items-center gap-3">
            <button type="submit" disabled={newPubSaving || !newPubName.trim() || !newPubSlug.trim()} className="btn disabled:opacity-50">
              {newPubSaving ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => { setShowNewPub(false); setNewPubError(null) }} className="btn-text-muted">
              Cancel
            </button>
          </div>
        </form>
      )}

      {isPublicationContext ? (
        /* Publication dashboard */
        <>
          <div className="flex items-center justify-between mb-10">
            <div className="flex gap-2">
              {pubTabs.map(tab => {
                const label = tab === 'rate-card' ? 'Rate card' : tab === 'payroll' ? 'Payroll' : tab === 'earnings' ? 'Earnings' : tab.charAt(0).toUpperCase() + tab.slice(1)
                return (
                  <button key={tab} onClick={() => switchPubTab(tab)} className={`tab-pill ${pubTab === tab ? 'tab-pill-active' : 'tab-pill-inactive'}`}>{label}</button>
                )
              })}
            </div>
            {inOverlay ? (
              <button type="button" onClick={() => { useDashboardOverlay.getState().close(); useEditorOverlay.getState().open({ publicationSlug: selectedPub.slug }) }} className="btn">New article</button>
            ) : (
              <Link href={`/write?pub=${selectedPub.slug}`} className="btn">New article</Link>
            )}
          </div>
          {pubTab === 'articles' && (
            <PublicationArticlesTab
              publicationId={selectedPub.id}
              publicationSlug={selectedPub.slug}
              canPublish={selectedPub.can_publish}
              canEditOthers={selectedPub.can_edit_others}
              inOverlay={inOverlay}
            />
          )}
          {pubTab === 'members' && (
            <MembersTab
              publicationId={selectedPub.id}
              publicationName={selectedPub.name}
              canManageMembers={selectedPub.can_manage_members}
              isOwner={selectedPub.is_owner}
            />
          )}
          {pubTab === 'settings' && selectedPub.can_manage_settings && (
            <PublicationSettingsTab
              publicationId={selectedPub.id}
              publicationSlug={selectedPub.slug}
              isOwner={selectedPub.is_owner}
            />
          )}
          {pubTab === 'rate-card' && selectedPub.can_manage_finances && (
            <RateCardTab publicationId={selectedPub.id} />
          )}
          {pubTab === 'payroll' && selectedPub.can_manage_finances && (
            <PayrollTab publicationId={selectedPub.id} />
          )}
          {pubTab === 'earnings' && selectedPub.can_manage_finances && (
            <PublicationEarningsTab publicationId={selectedPub.id} />
          )}
          {pubTab === 'analytics' && traffologyEnabled() && <AnalyticsTab />}
        </>
      ) : (
        /* Personal dashboard */
        <>
          <div className="flex items-center justify-between mb-10">
            <div className="flex gap-2">
              {personalTabs.map(tab => {
                const label = tab === 'proposals' ? 'Proposals' : tab === 'pricing' ? 'Pricing' : tab === 'subscribers' ? 'Subscribers' : tab.charAt(0).toUpperCase() + tab.slice(1)
                return (
                  <button key={tab} onClick={() => switchTab(tab)} className={`tab-pill ${activeTab === tab ? 'tab-pill-active' : 'tab-pill-inactive'}`}>{label}</button>
                )
              })}
            </div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => {
                  if (inOverlay) {
                    useDashboardOverlay.getState().close()
                    useLedgerOverlay.getState().open()
                  } else {
                    router.push('/reader?overlay=ledger')
                  }
                }}
                className="btn-text-muted underline underline-offset-4"
              >View ledger</button>
              {inOverlay ? (
                <button
                  type="button"
                  onClick={() => {
                    useDashboardOverlay.getState().close()
                    useEditorOverlay.getState().open()
                  }}
                  className="btn"
                >New article</button>
              ) : (
                <Link href="/write" className="btn">New article</Link>
              )}
            </div>
          </div>
          {activeTab === 'articles' && <ArticlesTab userId={user.id} pubkey={user.pubkey} inOverlay={inOverlay} />}
          {activeTab === 'subscribers' && <SubscribersTab />}
          {activeTab === 'proposals' && <ProposalsTab userId={user.id} />}
          {activeTab === 'pricing' && <PricingTab stripeReady={user.stripeConnectKycComplete} />}
          {activeTab === 'analytics' && traffologyEnabled() && <AnalyticsTab />}
        </>
      )}
    </>
  )
}

// =============================================================================
// Articles Tab (published + drafts unified)
// =============================================================================

type ContentItem =
  | { kind: 'published'; data: MyArticle }
  | { kind: 'draft'; data: { draftId: string; title: string; autoSavedAt: string; scheduledAt: string | null } }

function ArticlesTab({ userId, pubkey, inOverlay = false }: { userId: string; pubkey: string; inOverlay?: boolean }) {
  const [items, setItems] = useState<ContentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [giftLinksOpenId, setGiftLinksOpenId] = useState<string | null>(null)
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null)
  const [unpublishedMsg, setUnpublishedMsg] = useState<string | null>(null)
  const [schedulingId, setSchedulingId] = useState<string | null>(null)
  const [schedulePickerDraftId, setSchedulePickerDraftId] = useState<string | null>(null)
  const [scheduleDateTime, setScheduleDateTime] = useState('')

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const [articleRes, drafts] = await Promise.all([
          myArticles.list(),
          loadDrafts(),
        ])
        const published: ContentItem[] = articleRes.articles.map(a => ({ kind: 'published', data: a }))
        const draftItems: ContentItem[] = drafts.map((d: any) => ({ kind: 'draft', data: d }))
        // Drafts first, then published
        setItems([...draftItems, ...published])
      } catch { setError('Failed to load articles.') }
      finally { setLoading(false) }
    })()
  }, [userId])

  async function handleToggleReplies(id: string, on: boolean) {
    try {
      await myArticles.update(id, { repliesEnabled: on })
      setItems(p => p.map(item =>
        item.kind === 'published' && item.data.id === id
          ? { ...item, data: { ...item.data, repliesEnabled: on } }
          : item
      ))
    } catch { setError('Failed to update.') }
  }

  async function handleDeleteArticle(id: string) {
    setDeletingId(id)
    try {
      const result = await myArticles.remove(id)
      setItems(p => p.filter(item => !(item.kind === 'published' && item.data.id === id)))
      try {
        await signAndPublish({
          kind: KIND_DELETION,
          content: '',
          tags: [['e', result.nostrEventId], ['a', `30023:${pubkey}:${result.dTag}`]],
        })
      } catch { /* non-fatal */ }
    }
    catch { setError('Failed to delete.') }
    finally { setDeletingId(null) }
  }

  async function handleDeleteDraft(draftId: string) {
    setDeletingId(draftId)
    try {
      await deleteDraft(draftId)
      setItems(p => p.filter(item => !(item.kind === 'draft' && item.data.draftId === draftId)))
    } catch { setError('Failed to delete draft.') }
    finally { setDeletingId(null) }
  }

  async function handleUnpublish(id: string) {
    if (!confirm('Revert this article to draft? It will be removed from your public profile but not deleted.')) return
    setUnpublishingId(id)
    try {
      await myArticles.unpublish(id)
      setItems(p => p.filter(item => !(item.kind === 'published' && item.data.id === id)))
      setUnpublishedMsg('Moved to drafts.')
      setTimeout(() => setUnpublishedMsg(null), 3000)
    } catch { setError('Failed to unpublish.') }
    finally { setUnpublishingId(null) }
  }

  async function handleSchedule(draftId: string) {
    if (!scheduleDateTime) return
    setSchedulingId(draftId)
    try {
      const result = await scheduleDraft(draftId, new Date(scheduleDateTime).toISOString())
      setItems(p => p.map(item =>
        item.kind === 'draft' && item.data.draftId === draftId
          ? { ...item, data: { ...item.data, scheduledAt: result.scheduledAt } }
          : item
      ))
      setSchedulePickerDraftId(null)
      setScheduleDateTime('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to schedule.')
    } finally { setSchedulingId(null) }
  }

  async function handleUnschedule(draftId: string) {
    setSchedulingId(draftId)
    try {
      await unscheduleDraft(draftId)
      setItems(p => p.map(item =>
        item.kind === 'draft' && item.data.draftId === draftId
          ? { ...item, data: { ...item.data, scheduledAt: null } }
          : item
      ))
    } catch { setError('Failed to unschedule.') }
    finally { setSchedulingId(null) }
  }

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
  if (error) return <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black">{error}</div>
  if (items.length === 0) return <div className="py-20 text-center"><p className="text-ui-sm text-grey-600 mb-4">No articles or drafts yet.</p>{inOverlay ? <button type="button" onClick={() => { useDashboardOverlay.getState().close(); useEditorOverlay.getState().open() }} className="btn-text underline underline-offset-4">Write your first article</button> : <Link href="/write" className="btn-text underline underline-offset-4">Write your first article</Link>}</div>

  return (
    <div data-explain="dashboard.articles" className="overflow-x-auto bg-glasshouse-well">
      <table className="w-full text-ui-xs">
        <thead><tr className="border-b-2 border-grey-200"><th className="px-4 py-3 text-left label-ui text-grey-400">Title</th><th className="px-4 py-3 text-left label-ui text-grey-400">Status</th><th className="px-4 py-3 text-right label-ui text-grey-400">Reads</th><th className="px-4 py-3 text-right label-ui text-grey-400">Earned</th><th className="px-4 py-3 text-center label-ui text-grey-400">Replies</th><th className="px-4 py-3 text-right label-ui text-grey-400">Actions</th></tr></thead>
        <tbody>{items.map(item => {
          if (item.kind === 'draft') {
            const d = item.data
            const isScheduled = !!d.scheduledAt
            return (
              <React.Fragment key={`draft-${d.draftId}`}>
              <tr className="border-b-2 border-grey-200 last:border-b-0">
                <td className="px-4 py-3">
                  {inOverlay ? <button type="button" onClick={() => { useDashboardOverlay.getState().close(); useEditorOverlay.getState().open({ draftId: d.draftId }) }} className="text-black hover:opacity-70 text-left">{d.title || 'Untitled'}</button> : <Link href={`/write?draft=${d.draftId}`} className="text-black hover:opacity-70">{d.title || 'Untitled'}</Link>}
                  <p className="text-[11px] text-grey-300 mt-0.5">Saved {new Date(d.autoSavedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                </td>
                <td className="px-4 py-3">
                  {isScheduled ? (
                    <span className="text-black">Scheduled {new Date(d.scheduledAt!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  ) : (
                    <span className="text-grey-400">Draft</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-grey-300">&mdash;</td>
                <td className="px-4 py-3 text-right tabular-nums text-grey-300">&mdash;</td>
                <td className="px-4 py-3 text-center text-grey-300">&mdash;</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    {inOverlay ? <button type="button" onClick={() => { useDashboardOverlay.getState().close(); useEditorOverlay.getState().open({ draftId: d.draftId }) }} className="text-grey-400 hover:text-black">Edit</button> : <Link href={`/write?draft=${d.draftId}`} className="text-grey-400 hover:text-black">Edit</Link>}
                    {isScheduled ? (
                      <>
                        <button onClick={() => { setSchedulePickerDraftId(d.draftId); setScheduleDateTime(d.scheduledAt!.slice(0, 16)) }} className="text-grey-400 hover:text-black">Reschedule</button>
                        <button onClick={() => handleUnschedule(d.draftId)} disabled={schedulingId === d.draftId} className="text-grey-300 hover:text-black disabled:opacity-50">{schedulingId === d.draftId ? '...' : 'Unschedule'}</button>
                      </>
                    ) : (
                      <button onClick={() => setSchedulePickerDraftId(schedulePickerDraftId === d.draftId ? null : d.draftId)} className="text-grey-400 hover:text-black">Schedule</button>
                    )}
                    <button onClick={() => handleDeleteDraft(d.draftId)} disabled={deletingId === d.draftId} className="text-grey-300 hover:text-black disabled:opacity-50">{deletingId === d.draftId ? '...' : 'Delete'}</button>
                  </div>
                </td>
              </tr>
              {schedulePickerDraftId === d.draftId && (
                <tr><td colSpan={6} className="bg-grey-50 border-b-2 border-grey-200 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <input
                      type="datetime-local"
                      value={scheduleDateTime}
                      onChange={e => setScheduleDateTime(e.target.value)}
                      min={new Date().toISOString().slice(0, 16)}
                      className="bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                    />
                    <button
                      onClick={() => handleSchedule(d.draftId)}
                      disabled={schedulingId === d.draftId || !scheduleDateTime}
                      className="btn text-sm disabled:opacity-50"
                    >
                      {schedulingId === d.draftId ? '...' : isScheduled ? 'Update schedule' : 'Confirm schedule'}
                    </button>
                    <button onClick={() => { setSchedulePickerDraftId(null); setScheduleDateTime('') }} className="text-ui-xs text-grey-300 hover:text-black">Cancel</button>
                  </div>
                </td></tr>
              )}
              </React.Fragment>
            )
          }
          const a = item.data
          return (
            <React.Fragment key={a.id}>
            <tr className="border-b-2 border-grey-200 last:border-b-0">
              <td className="px-4 py-3">{inOverlay ? <button type="button" onClick={() => { useDashboardOverlay.getState().close(); useReader.getState().openNative(a.dTag) }} className="text-black hover:opacity-70 text-left">{a.title}</button> : <Link href={`/article/${a.dTag}`} className="text-black hover:opacity-70">{a.title}</Link>}</td>
              <td className="px-4 py-3">{a.isPaywalled ? <span className="text-black">£{((a.pricePence??0)/100).toFixed(2)}</span> : <span className="text-grey-400">Free</span>}</td>
              <td className="px-4 py-3 text-right tabular-nums">{a.readCount}</td>
              <td className="px-4 py-3 text-right text-black tabular-nums">£{(a.netEarningsPence/100).toFixed(2)}</td>
              <td className="px-4 py-3 text-center"><button onClick={() => handleToggleReplies(a.id, !a.repliesEnabled)} className={`text-ui-xs ${a.repliesEnabled ? 'text-crimson' : 'text-grey-300'}`}>{a.repliesEnabled ? 'On' : 'Off'}</button></td>
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-3">
                  {a.isPaywalled && (
                    <button onClick={() => setGiftLinksOpenId(giftLinksOpenId === a.id ? null : a.id)} data-explain="dashboard.gifts" className={`text-grey-300 hover:text-black ${giftLinksOpenId === a.id ? 'text-black' : ''}`}>Gifts</button>
                  )}
                  {inOverlay ? <button type="button" onClick={() => { useDashboardOverlay.getState().close(); useEditorOverlay.getState().open({ editEventId: a.nostrEventId }) }} className="text-grey-400 hover:text-black">Edit</button> : <Link href={`/write?edit=${a.nostrEventId}`} className="text-grey-400 hover:text-black">Edit</Link>}
                  <button onClick={() => handleUnpublish(a.id)} disabled={unpublishingId===a.id} className="text-grey-300 hover:text-black disabled:opacity-50">{unpublishingId===a.id ? '...' : 'Unpublish'}</button>
                  <button onClick={() => handleDeleteArticle(a.id)} disabled={deletingId===a.id} className="text-grey-300 hover:text-black disabled:opacity-50">{deletingId===a.id ? '...' : 'Delete'}</button>
                </div>
              </td>
            </tr>
            {giftLinksOpenId === a.id && (
              <tr><td colSpan={6} className="bg-grey-50 border-b-2 border-grey-200"><GiftLinksPanel articleId={a.id} dTag={a.dTag} /></td></tr>
            )}
            </React.Fragment>
          )
        })}
        </tbody>
      </table>
      {unpublishedMsg && <p className="text-ui-xs text-grey-600 px-4 py-2">{unpublishedMsg}</p>}
    </div>
  )
}

// =============================================================================
// Pricing Tab — subscription price, per-article pricing, Stripe status
// =============================================================================

function PricingTab({ stripeReady }: { stripeReady: boolean }) {
  const { user, fetchMe } = useAuth()
  const [subPrice, setSubPrice] = useState('')
  const [annualDiscount, setAnnualDiscount] = useState('15')
  const [articlePriceMode, setArticlePriceMode] = useState<'auto' | 'fixed'>(
    user?.defaultArticlePricePence != null ? 'fixed' : 'auto'
  )
  const [fixedArticlePrice, setFixedArticlePrice] = useState(
    user?.defaultArticlePricePence != null ? (user.defaultArticlePricePence / 100).toFixed(2) : ''
  )
  const [savingPrice, setSavingPrice] = useState(false)
  const [priceMsg, setPriceMsg] = useState<string | null>(null)

  async function handleSavePrice(e: React.FormEvent) {
    e.preventDefault()
    const pence = Math.round(parseFloat(subPrice) * 100)
    const discount = parseInt(annualDiscount, 10)
    if (isNaN(pence) || pence < 0) { setPriceMsg('Enter a valid price.'); return }
    if (isNaN(discount) || discount < 0 || discount > 30) { setPriceMsg('Discount must be 0–30%.'); return }
    const defaultArticlePricePence = articlePriceMode === 'fixed'
      ? Math.round(parseFloat(fixedArticlePrice || '0') * 100)
      : null
    if (articlePriceMode === 'fixed' && (isNaN(defaultArticlePricePence!) || defaultArticlePricePence! < 0)) {
      setPriceMsg('Enter a valid per-article price.'); return
    }
    setSavingPrice(true); setPriceMsg(null)
    try {
      await accountApi.updateSubscriptionPrice(pence, discount, defaultArticlePricePence)
      await fetchMe()
      setPriceMsg('Pricing updated.')
    } catch { setPriceMsg('Failed to update.') }
    finally { setSavingPrice(false) }
  }

  const monthlyPence = Math.round(parseFloat(subPrice || '0') * 100)
  const discountPct = parseInt(annualDiscount || '0', 10)
  const annualPence = Math.round(monthlyPence * 12 * (1 - discountPct / 100))
  const annualPounds = (annualPence / 100).toFixed(2)

  return (
    <div data-explain="dashboard.pricing" className="space-y-8">
      <form onSubmit={handleSavePrice} className="space-y-8">
        {/* Subscription price */}
        <div className="bg-glasshouse-well px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Subscription pricing</p>
          <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
            Set the monthly price readers pay to subscribe to your content. Readers can also choose an annual plan at a discount you configure.
          </p>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-ui-sm font-sans text-grey-400">£</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={subPrice}
                onChange={(e) => setSubPrice(e.target.value)}
                className="w-28 bg-grey-100 px-3 py-1.5 text-ui-sm font-sans text-black placeholder-grey-300"
                placeholder="3.00"
              />
              <span className="text-ui-xs font-sans text-grey-300">/month</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-ui-sm font-sans text-grey-400 w-[13px]">%</span>
              <input
                type="number"
                min="0"
                max="30"
                value={annualDiscount}
                onChange={(e) => setAnnualDiscount(e.target.value)}
                className="w-28 bg-grey-100 px-3 py-1.5 text-ui-sm font-sans text-black placeholder-grey-300"
                placeholder="15"
              />
              <span className="text-ui-xs font-sans text-grey-300">annual discount</span>
            </div>
            {monthlyPence > 0 && (
              <p className="text-ui-xs font-sans text-grey-400">
                Readers pay £{subPrice}/mo or £{annualPounds}/year{discountPct > 0 ? ` (save ${discountPct}%)` : ''}
              </p>
            )}
          </div>
        </div>

        {/* Per-article pricing */}
        <div className="bg-glasshouse-well px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Per-article pricing</p>
          <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
            Default price for paywalled articles. You can override this per article in the editor. Free articles are always free.
          </p>
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setArticlePriceMode('auto')}
              className={`w-full text-left px-4 py-3 transition-colors ${
                articlePriceMode === 'auto' ? 'bg-black text-white' : 'bg-grey-100 text-black hover:bg-grey-200/60'
              }`}
            >
              <p className={`text-ui-sm font-medium ${articlePriceMode === 'auto' ? 'text-white' : 'text-black'}`}>
                Auto
              </p>
              <p className={`text-ui-xs mt-0.5 ${articlePriceMode === 'auto' ? 'text-grey-300' : 'text-grey-400'}`}>
                Price scales with article length
              </p>
            </button>
            <button
              type="button"
              onClick={() => setArticlePriceMode('fixed')}
              className={`w-full text-left px-4 py-3 transition-colors ${
                articlePriceMode === 'fixed' ? 'bg-black text-white' : 'bg-grey-100 text-black hover:bg-grey-200/60'
              }`}
            >
              <p className={`text-ui-sm font-medium ${articlePriceMode === 'fixed' ? 'text-white' : 'text-black'}`}>
                Fixed default
              </p>
              <p className={`text-ui-xs mt-0.5 ${articlePriceMode === 'fixed' ? 'text-grey-300' : 'text-grey-400'}`}>
                Same starting price for every paywalled article
              </p>
            </button>
            {articlePriceMode === 'fixed' && (
              <div className="flex items-center gap-3 pt-1">
                <span className="text-ui-sm font-sans text-grey-400">£</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={fixedArticlePrice}
                  onChange={(e) => setFixedArticlePrice(e.target.value)}
                  className="w-28 bg-grey-100 px-3 py-1.5 text-ui-sm font-sans text-black placeholder-grey-300"
                  placeholder="0.20"
                />
                <span className="text-ui-xs font-sans text-grey-300">per read</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-6">
          <button type="submit" disabled={savingPrice} className="btn text-sm disabled:opacity-50">
            {savingPrice ? 'Saving…' : 'Save pricing'}
          </button>
          {priceMsg && <p className="text-ui-xs font-sans text-grey-600 mt-2">{priceMsg}</p>}
        </div>
      </form>

      {/* Welcome message — its own form, because it saves independently of
          pricing and a writer editing prose should not have to re-submit a
          price to keep it. */}
      <WelcomeMessageSection />

      {/* Stripe Connect status */}
      <div className="bg-glasshouse-well px-6 py-5">
        <p className="label-ui text-grey-400 mb-4">Stripe Connect</p>
        {stripeReady ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-ui-sm text-black">Verified</p>
              <p className="text-ui-xs text-grey-300 mt-0.5">Payouts are enabled.</p>
            </div>
            <span className="text-ui-xs text-grey-400">Active</span>
          </div>
        ) : (
          <StripeConnectSetup />
        )}
      </div>

    </div>
  )
}

// =============================================================================
// Welcome message — the writer's own words, sent to a reader on subscribing
//
// Plain text, 2000 characters, matching the zod bound on the route and the
// CHECK on the column (migration 180). An empty box is saved as `null` and the
// reader is sent the default template — which is a real welcome, not silence,
// so leaving this alone is a perfectly good answer and the copy says so.
// =============================================================================

const WELCOME_MAX = 2000

function WelcomeMessageSection() {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    accountApi.getSubscriptionWelcome()
      .then((r) => { if (live) setMessage(r.message ?? '') })
      .catch(() => { /* leave the box empty; saving still works */ })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setMsg(null)
    try {
      // Empty box → null, so the column records "not set" rather than an empty
      // string, and the reader gets the default rather than a blank email.
      const trimmed = message.trim()
      await accountApi.updateSubscriptionWelcome(trimmed.length > 0 ? trimmed : null)
      setMsg(trimmed.length > 0 ? 'Welcome message saved.' : 'Cleared — subscribers get the default welcome.')
    } catch { setMsg('Failed to save.') }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSave} className="bg-glasshouse-well px-6 py-5">
      <p className="label-ui text-grey-400 mb-4">Welcome message</p>
      <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
        Sent to a reader the moment they subscribe — the one time you know they
        are listening. Leave it empty and we send a short welcome in your name.
      </p>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        maxLength={WELCOME_MAX}
        rows={6}
        disabled={loading}
        placeholder={loading ? '' : 'Thanks for subscribing. Here is what you can expect from me…'}
        className="w-full bg-grey-100 px-4 py-2.5 text-ui-sm font-sans text-black placeholder-grey-300 focus:outline-none resize-none disabled:opacity-50"
      />
      <p className="text-ui-xs font-sans text-grey-300 mt-1 text-right">
        {message.length}/{WELCOME_MAX}
      </p>
      <div className="mt-3">
        <button type="submit" disabled={saving || loading} className="btn text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Save welcome message'}
        </button>
        {msg && <p className="text-ui-xs font-sans text-grey-600 mt-2">{msg}</p>}
      </div>
    </form>
  )
}

// =============================================================================
// Stripe Connect Setup (inline)
// =============================================================================

function StripeConnectSetup() {
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConnect() {
    setConnecting(true); setError(null)
    try {
      const result = await auth.connectStripe()
      window.location.href = result.stripeConnectUrl
    } catch {
      setError('Failed to start Stripe setup.')
      setConnecting(false)
    }
  }

  return (
    <div>
      <p className="text-ui-xs text-grey-600 mb-3">Connect Stripe to receive payouts from articles and subscriptions.</p>
      {error && <p className="text-ui-xs text-red-600 mb-3">{error}</p>}
      <button onClick={handleConnect} disabled={connecting} className="btn disabled:opacity-50">
        {connecting ? 'Setting up…' : 'Connect Stripe'}
      </button>
    </div>
  )
}

// =============================================================================
// Skeleton
// =============================================================================

export function DashboardSkeleton() {
  return (
    <>
      <div className="flex gap-2 mb-10">{[1,2,3,4].map(i => <div key={i} className="h-9 w-24 animate-pulse bg-glasshouse-well"/>)}</div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{[1,2,3].map(i => <div key={i} className="bg-glasshouse-well p-6"><div className="h-3 w-20 animate-pulse bg-grey-100 mb-3"/><div className="h-7 w-28 animate-pulse bg-grey-100"/></div>)}</div>
    </>
  )
}
