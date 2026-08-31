import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { PublicationMasthead } from '../../../../components/publication/PublicationMasthead'
import { PublicPage } from '../../../../components/public/PublicPage'
import {
  EmptyState,
  LoadFailed,
  type PubArticle,
} from '../../../../components/publication/article-shared'
import { PubArchive } from '../../../../components/publication/pub-sections'
import WorkspacePaneRedirect from '../../../../components/layout/WorkspacePaneRedirect'

// =============================================================================
// Publication archive — /pub/:slug/archive
//
// The route: fetch, decide between the three outcomes, and hand the list to
// `PubArchive`, which is the same body the workspace overlay renders.
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getPublication(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/public`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

/** null means the fetch FAILED — distinct from a publication with no articles. */
async function getArticles(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/by-slug/${slug}/articles?limit=100`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const pub = await getPublication(params.slug)
  if (!pub) return {}
  return {
    title: `Archive — ${pub.name} — all.haus`,
    description: `Every article published by ${pub.name}`,
  }
}

export default async function ArchivePage({ params }: { params: { slug: string } }) {
  const [pub, data] = await Promise.all([
    getPublication(params.slug),
    getArticles(params.slug),
  ])
  if (!pub) return notFound()

  const failed = data === null
  const articles: PubArticle[] = data?.articles ?? []

  return (
    <PublicPage>
      <WorkspacePaneRedirect overlay="surface" params={{ surface: `/pub/${params.slug}/archive` }} />
      <PublicationMasthead pub={pub} view="archive" />
      <div className="mx-auto max-w-feed px-4 sm:px-6 pt-14 pb-20">
        {failed ? (
          <LoadFailed what="this archive" />
        ) : articles.length === 0 ? (
          <EmptyState />
        ) : (
          <PubArchive slug={params.slug} articles={articles} />
        )}
      </div>
    </PublicPage>
  )
}
