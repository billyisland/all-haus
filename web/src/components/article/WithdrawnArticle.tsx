'use client'

import { useEffect, useState } from 'react'
import { ArticleReader } from './ArticleReader'
import { PublicPage } from '../public/PublicPage'
import { PublicLink } from '../public/Field'
import { ReadingScrollbar } from '../layout/ReadingScrollbar'
import { publicationsEnabled } from '../../lib/featureFlags'
import type { ArticleMetadata } from '../../lib/api'
import {
  ARTICLE_NOT_HERE_BODY,
  ARTICLE_NOT_HERE_TITLE,
  ARTICLE_UNREACHABLE_BODY,
  ARTICLE_UNREACHABLE_TITLE,
} from '../../content/article'
import { request, ApiError } from '../../lib/api/client'

// =============================================================================
// A withdrawn piece, for the reader who paid for it (§0z item 18; Writer 3.4)
//
// The article page's server fetch is anonymous and cached across viewers, so
// a withdrawn piece answers it 404 for everyone — which is right for the
// world. This component is what the page renders INSTEAD of the not-found
// view: it asks the same route again with the viewer's own cookie, and the
// gateway answers the piece to a session holding an `article_unlocks` row and
// 404 to anyone else. The reader then mounts exactly as the page mounts it,
// rendering its own markdown (no pre-rendered HTML here), and the gate pass
// re-issues the key without a charge.
// =============================================================================

export function WithdrawnArticle({ dTag }: { dTag: string }) {
  // `failed` is not `article: null`: only a 404 says the piece is not here
  // for this viewer, and an outage saying so would tell somebody who PAID for
  // it that it is gone.
  const [state, setState] = useState<{
    article: ArticleMetadata | null
    done: boolean
    failed: boolean
  }>({ article: null, done: false, failed: false })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const article = await request<ArticleMetadata>(`/articles/${encodeURIComponent(dTag)}`)
        if (!cancelled) setState({ article, done: true, failed: false })
      } catch (err) {
        if (cancelled) return
        const absent = err instanceof ApiError && err.status === 404
        setState({ article: null, done: true, failed: !absent })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dTag, attempt])

  if (!state.done) return null

  if (state.failed) {
    return (
      <PublicPage>
        <div className="mx-auto max-w-article px-4 py-24">
          <h1 className="font-serif text-[26px] font-normal text-black mb-3">{ARTICLE_UNREACHABLE_TITLE}</h1>
          <p className="font-sans text-[15px] text-grey-600 leading-[1.6]">
            {ARTICLE_UNREACHABLE_BODY}{' '}
            <PublicLink onClick={() => setAttempt((n) => n + 1)}>Try again</PublicLink>
          </p>
        </div>
      </PublicPage>
    )
  }

  if (!state.article) {
    return (
      <PublicPage>
        <div className="mx-auto max-w-article px-4 py-24">
          <h1 className="font-serif text-[26px] font-normal text-black mb-3">{ARTICLE_NOT_HERE_TITLE}</h1>
          <p className="font-sans text-[15px] text-grey-600 leading-[1.6]">
            {ARTICLE_NOT_HERE_BODY}
          </p>
        </div>
      </PublicPage>
    )
  }

  const article = state.article
  const publication = publicationsEnabled() ? (article.publication ?? null) : null
  return (
    <PublicPage ground={false} barGround="var(--ah-white)">
      <ReadingScrollbar />
      <ArticleReader
        postId={article.postId}
        article={{
          id: article.nostrEventId,
          pubkey: article.writer.pubkey,
          dTag: article.dTag,
          title: article.title,
          summary: article.summary ?? '',
          content: article.contentFree ?? '',
          publishedAt: article.publishedAt
            ? Math.floor(new Date(article.publishedAt).getTime() / 1000)
            : 0,
          tags: [],
          pricePence: article.pricePence ?? undefined,
          gatePositionPct: article.gatePositionPct ?? undefined,
          isPaywalled: article.isPaywalled,
        }}
        coverImageUrl={article.coverImageUrl ?? null}
        articleDbId={article.id}
        writerName={article.writer.displayName ?? article.writer.username}
        writerUsername={article.writer.username}
        writerAvatar={article.writer.avatar ?? undefined}
        writerId={article.writer.id}
        subscriptionPricePence={publication?.subscriptionPricePence ?? article.writer.subscriptionPricePence}
        writerSpendThisMonthPence={article.writerSpendThisMonthPence ?? undefined}
        publicationName={publication?.name ?? undefined}
        publicationSlug={publication?.slug ?? undefined}
        withdrawn={article.withdrawn === true}
      />
    </PublicPage>
  )
}
