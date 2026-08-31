import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { PublicationMasthead } from '../../../components/publication/PublicationMasthead'
import { LoadFailed } from '../../../components/publication/article-shared'
import { PubHomepage } from '../../../components/publication/pub-sections'
import { PublicPage } from '../../../components/public/PublicPage'
import WorkspacePaneRedirect from '../../../components/layout/WorkspacePaneRedirect'

// =============================================================================
// Publication homepage — /pub/:slug  (Server Component)
//
// THE CHASSIS IS THE PUBLIC REGISTER, not a chassis of its own. This route used
// to sit inside `pub/[slug]/layout.tsx`, which mounted a `PublicationNav` bar
// and a `PublicationFooter` — on a route where `LayoutShell` already mounts the
// sitewide `PublicNavRow`, so the page carried two navigations and, because the
// layout never cleared `--ah-row-band`, the fixed row sat over the footer. Both
// are deleted; `PublicPage` paints the bone ground and reserves the band, and
// the publication's identity is carried by `PublicationMasthead`.
//
// The cover is full-bleed and the article body is measured, so the masthead
// sits OUTSIDE the measured column and each template centres its own body.
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'
const SITE_URL = process.env.APP_URL ?? 'https://all.haus'

async function getPublication(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/public`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

/** null means the fetch FAILED — distinct from a publication with no articles. */
async function getArticles(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/by-slug/${slug}/articles?limit=20`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const pub = await getPublication(params.slug)
  if (!pub) return {}

  const title = `${pub.name} — all.haus`
  const description = pub.tagline || `${pub.name} on all.haus`
  const url = `${SITE_URL}/pub/${params.slug}`
  const image = pub.cover_blossom_url ?? pub.logo_blossom_url

  return {
    title,
    description,
    alternates: {
      types: {
        'application/rss+xml': `${SITE_URL}/api/v1/pub/${params.slug}/rss`,
      },
    },
    openGraph: {
      title,
      description,
      type: 'website',
      url,
      siteName: 'all.haus',
      ...(image && { images: [{ url: image }] }),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
    },
  }
}

export default async function PublicationHomepage({ params }: { params: { slug: string } }) {
  const [pub, data] = await Promise.all([
    getPublication(params.slug),
    getArticles(params.slug),
  ])
  if (!pub) return notFound()

  const failed = data === null
  const articles = data?.articles ?? []

  return (
    <PublicPage>
      <WorkspacePaneRedirect overlay="surface" params={{ surface: `/pub/${params.slug}` }} />
      <PublicationMasthead pub={pub} view="home" />
      <div className="mx-auto max-w-content px-4 sm:px-6 pt-14 pb-20">
        {/* An outage renders as an outage, not as a publication with nothing in
            it — every template's own empty state would otherwise make that
            claim. The masthead above still renders: `pub` loaded, so the
            publication's identity is known and only its articles are missing. */}
        {failed ? (
          <LoadFailed what="these articles" />
        ) : (
          <PubHomepage
            slug={pub.slug}
            layout={pub.homepage_layout}
            articles={articles}
          />
        )}
      </div>
    </PublicPage>
  )
}
