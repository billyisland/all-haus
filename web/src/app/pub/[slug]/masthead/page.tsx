import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { PublicationMasthead } from '../../../../components/publication/PublicationMasthead'
import { LoadFailed } from '../../../../components/publication/article-shared'
import {
  PubMastheadList,
  type MastheadMember,
} from '../../../../components/publication/pub-sections'
import { PublicPage } from '../../../../components/public/PublicPage'
import WorkspacePaneRedirect from '../../../../components/layout/WorkspacePaneRedirect'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getPublication(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/public`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

/** null means the fetch FAILED — distinct from a publication with no masthead. */
async function getMasthead(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/masthead`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const pub = await getPublication(params.slug)
  if (!pub) return {}

  const title = `Masthead — ${pub.name} — all.haus`
  const description = `The team behind ${pub.name}`

  return {
    title,
    description,
    openGraph: { title, description, type: 'website', siteName: 'all.haus' },
    twitter: { card: 'summary', title, description },
  }
}

export default async function MastheadPage({ params }: { params: { slug: string } }) {
  const [pub, data] = await Promise.all([
    getPublication(params.slug),
    getMasthead(params.slug),
  ])
  if (!pub) return notFound()

  const failed = data === null
  const members: MastheadMember[] = data?.members ?? []

  return (
    <PublicPage>
      <WorkspacePaneRedirect overlay="surface" params={{ surface: `/pub/${params.slug}/masthead` }} />
      <PublicationMasthead pub={pub} view="masthead" />
      <div className="mx-auto max-w-feed px-4 sm:px-6 pt-14 pb-20">
        {failed ? (
          <LoadFailed what="this masthead" />
        ) : members.length === 0 ? (
          <p className="label-ui text-grey-600 py-16 text-center">NO MASTHEAD YET</p>
        ) : (
          <PubMastheadList members={members} />
        )}
      </div>
    </PublicPage>
  )
}
