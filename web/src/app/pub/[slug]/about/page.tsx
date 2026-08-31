import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { renderMarkdown } from '../../../../lib/markdown'
import { PublicationMasthead } from '../../../../components/publication/PublicationMasthead'
import { PublicPage } from '../../../../components/public/PublicPage'
import WorkspacePaneRedirect from '../../../../components/layout/WorkspacePaneRedirect'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'
const SITE_URL = process.env.APP_URL ?? 'https://all.haus'

async function getPublication(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/public`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const pub = await getPublication(params.slug)
  if (!pub) return {}

  const title = `About ${pub.name} — all.haus`
  const description = pub.tagline || `About ${pub.name} on all.haus`
  const url = `${SITE_URL}/pub/${params.slug}/about`

  return {
    title,
    description,
    openGraph: { title, description, type: 'website', url, siteName: 'all.haus' },
    twitter: { card: 'summary', title, description },
  }
}

export default async function AboutPage({ params }: { params: { slug: string } }) {
  const pub = await getPublication(params.slug)
  if (!pub) return notFound()

  const aboutHtml = pub.about ? await renderMarkdown(pub.about) : null

  return (
    <PublicPage>
      <WorkspacePaneRedirect overlay="surface" params={{ surface: `/pub/${params.slug}/about` }} />
      <PublicationMasthead pub={pub} view="about" />
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-14 pb-20">
        {aboutHtml ? (
          <div className="prose" dangerouslySetInnerHTML={{ __html: aboutHtml }} />
        ) : (
          <p className="label-ui text-grey-600 py-16 text-center">
            NO ABOUT PAGE YET
          </p>
        )}
      </div>
    </PublicPage>
  )
}
