'use client'

import { useEffect, useState } from 'react'
import { ArticleReader } from '../../../components/article/ArticleReader'
import { LoadFailed } from '../../../components/ui/LoadFailed'
import { loadDraft, type LoadedDraft } from '../../../lib/drafts'
import { splitAtGateMarker } from '../../../lib/gate-marker'
import { useAuth } from '../../../stores/auth'

// =============================================================================
// The client half of /preview/:draftId — see the server shell beside it.
//
// THREE STATES, NOT TWO. `loadDraft` distinguishes an outage (undefined) from a
// definitive "no such draft of yours" (null), and so does this: an outage says
// so and invites a retry, an absence says the draft is not there. Folding them
// together is the *outage renders as an outage* rule, and it fails in the
// direction that tells a writer their unpublished work is gone.
//
// THE WRITER COMES FROM `useAuth()`. The gateway route is writer-scoped on the
// session cookie and correctly carries no writer identity, and the viewer is
// the author by construction — a draft that is not yours answers 404.
// =============================================================================

export function DraftPreview({ draftId }: { draftId: string }) {
  const { user, loading: authLoading } = useAuth()
  const [draft, setDraft] = useState<LoadedDraft | null | undefined>(undefined)
  const [state, setState] = useState<'loading' | 'ready' | 'absent' | 'failed'>('loading')

  useEffect(() => {
    if (authLoading) return
    if (!user) { setState('absent'); return }
    let cancelled = false
    void loadDraft(draftId).then((d) => {
      if (cancelled) return
      if (d === undefined) { setState('failed'); return }
      if (d === null) { setState('absent'); return }
      setDraft(d)
      setState('ready')
    })
    return () => { cancelled = true }
  }, [draftId, user, authLoading])

  // WAITING IS THE SLAB, NOT A SKELETON — and it is built from tokens rather
  // than by importing `IndeterminateSlab`, for the dark-mode reason
  // `ReplySection` records: that component's track is
  // `controlLine(usePublicPalette())`, which only resolves to bone inside
  // `LIGHT_ISLAND_STYLE`, and this page is not islanded. `var(--ah-ink)` is a
  // DARK_SLUG and inverts once, on its own, correctly in both modes. The sweep
  // and its reduced-motion resting state live in `.ah-indeterminate-slab`.
  if (state === 'loading') {
    return (
      <div className="mx-auto max-w-article px-4 py-24">
        <div
          role="progressbar"
          aria-label="Loading"
          style={{ height: 4, background: 'var(--ah-ink)', overflow: 'hidden' }}
        >
          <div
            className="ah-indeterminate-slab"
            style={{ height: 4, background: 'var(--ah-crimson)' }}
          />
        </div>
      </div>
    )
  }

  if (state === 'failed') {
    return (
      <div className="mx-auto max-w-article px-4">
        <LoadFailed what="this draft" />
      </div>
    )
  }

  if (state === 'absent' || !draft) {
    return (
      <div className="mx-auto max-w-article px-4 py-24 text-center">
        <p className="label-ui text-grey-600">NO SUCH DRAFT</p>
        <p className="mt-3 font-sans text-ui-sm text-grey-600">
          This draft doesn&rsquo;t exist, or it isn&rsquo;t yours. Only the writer can preview a draft.
        </p>
      </div>
    )
  }

  // The gate falls where PUBLISH would put it — the same function, not a second
  // reading of the marker (`lib/gate-marker.ts`). A preview that split
  // differently would show the writer a gate their readers will not find.
  const { free, paywall } = splitAtGateMarker(draft.content ?? '')
  const isPaywalled = paywall.length > 0

  const writerName = user?.displayName ?? user?.username ?? 'You'

  return (
    <ArticleReader
      preview
      previewPaywallBody={isPaywalled ? paywall : null}
      article={{
        // NO `id`, NO `pubkey`, and `dTag` only if this draft is an edit of a
        // published piece. A never-published draft has none of the three, and
        // they are LEFT OUT rather than filled with '' — an empty-string event
        // id reaching the unlock cache or a report would not throw, which is
        // exactly why it must not be there. `ArticleReader`'s `preview` prop
        // suppresses everything that would have spent one.
        dTag: draft.dTag,
        title: draft.title || 'Untitled',
        summary: draft.dek ?? '',
        content: free,
        // The byline dates the LAST SAVE, which the reader labels as such.
        publishedAt: Math.floor(Date.parse(draft.autoSavedAt) / 1000),
        tags: [],
        pricePence: draft.pricePence ?? undefined,
        isPaywalled,
      }}
      coverImageUrl={draft.coverImageUrl ?? null}
      writerName={writerName}
      writerUsername={user?.username ?? ''}
      writerAvatar={user?.avatar ?? undefined}
      writerId={user?.id}
    />
  )
}
