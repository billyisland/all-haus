import type { Metadata } from 'next'
import { TagBrowser } from './TagBrowser'
import { PublicPage } from '../../../components/public/PublicPage'
import type { Post } from '../../../lib/post/types'

// =============================================================================
// /tag/:name — articles for one tag (Server Component)
//
// Fetches the tag's article page from the gateway at request time and passes it
// to the TagBrowser client component as initial data, so the article list is in
// the served HTML (SEO + no blank → JS → fetch flash). The endpoint is
// optionalAuth and viewer-independent (tags are article-only and vote counts
// are global; the per-viewer bookmark state this note used to cite is gone
// with the bookmarks feature, migration 189), so the anonymous fetch is safe
// to cache across viewers via `revalidate`.
//
// THIS SERVER FETCH IS ANONYMOUS AND CROSS-VIEWER CACHED (`revalidate: 60`),
// and it now serves MEMBERS TOO. The sentence that used to stand here —
// "so this server fetch only ever serves the logged-out / crawler view" —
// rested on the workspace bounce, which D5 deleted (PAYWALL-ARRIVAL-ADR).
//
// Nothing breaks, and the reason is worth stating rather than assuming: the
// payload is viewer-INDEPENDENT. A tag listing is the same rows for everyone,
// the route derives nothing from a session, and no cookie is forwarded — so
// what is cached is a fact about the tag, not about a reader. Contrast
// /article/[dTag], whose payload does carry two viewer-derived fields and which
// therefore had to grow a viewer-scoped client read to go with them
// (ArticleReader). The rule is the same in both: a value derived from the
// viewer is omitted for an anonymous read, never defaulted — and it may not be
// served out of a cache shared with other viewers. (perf-audit #5 residual.)
// =============================================================================

const GATEWAY =
  process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

type TagPostsResponse = {
  tag: string
  items: Post[]
  total: number
  nextCursor?: string
}

async function getTagPosts(tagName: string): Promise<TagPostsResponse | null> {
  try {
    const res = await fetch(
      `${GATEWAY}/api/v1/tags/${encodeURIComponent(tagName)}/posts`,
      { next: { revalidate: 60 } },
    )
    if (!res.ok) return null
    return (await res.json()) as TagPostsResponse
  } catch {
    // Gateway unreachable at build/request time → fall back to client fetch.
    return null
  }
}

export async function generateMetadata({ params }: { params: { tag: string } }): Promise<Metadata> {
  const tagName = params.tag.toLowerCase()
  const title = `#${tagName} — all.haus`
  const description = `Articles tagged #${tagName} on all.haus`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: 'all.haus',
    },
    twitter: {
      card: 'summary',
      title,
      description,
    },
  }
}

export default async function TagPage({ params }: { params: { tag: string } }) {
  const tagName = params.tag.toLowerCase()
  const data = await getTagPosts(tagName)
  // Wrapper only. TagBrowser is also mounted by SurfaceOverlay inside the
  // workspace, so its internals are a member-surface question, not a
  // logged-out one.
  return (
    <PublicPage>
      <TagBrowser
        tagName={tagName}
        initialItems={data?.items}
        initialTotal={data?.total}
        initialCursor={data?.nextCursor}
      />
    </PublicPage>
  )
}
