import type { Metadata } from 'next'
import { TagBrowser } from './TagBrowser'
import WorkspacePaneRedirect from '../../../components/layout/WorkspacePaneRedirect'
import { PublicPage } from '../../../components/public/PublicPage'
import type { Post } from '../../../lib/post/types'

// =============================================================================
// /tag/:name — articles for one tag (Server Component)
//
// Fetches the tag's article page from the gateway at request time and passes it
// to the TagBrowser client component as initial data, so the article list is in
// the served HTML (SEO + no blank → JS → fetch flash). The endpoint is
// optionalAuth and viewer-independent (tags are article-only, vote counts are
// global, bookmark state is per-viewer and hydrates client-side), so the
// anonymous fetch is safe to cache across viewers via `revalidate`.
//
// Logged-in visitors are redirected into the workspace surface overlay
// (WorkspacePaneRedirect); the overlay's TagBrowser carries no initial data and
// fetches client-side with the viewer's cookie, so this server fetch only ever
// serves the logged-out / crawler view. (perf-audit #5 residual.)
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
      <WorkspacePaneRedirect overlay="surface" params={{ surface: `/tag/${tagName}` }} />
      <TagBrowser
        tagName={tagName}
        initialItems={data?.items}
        initialTotal={data?.total}
        initialCursor={data?.nextCursor}
      />
    </PublicPage>
  )
}
