import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { PublicationMasthead } from '../../../../components/publication/PublicationMasthead'
import { PubSubscribeTerms } from '../../../../components/publication/pub-sections'
import { PublicPage } from '../../../../components/public/PublicPage'
import WorkspacePaneRedirect from '../../../../components/layout/WorkspacePaneRedirect'

// =============================================================================
// Publication subscribe — /pub/:slug/subscribe
//
// The terms live in `PubSubscribeTerms`, shared with the workspace overlay —
// which, until this pass, had no way to reach them at all: a member could read
// a publication for a month without once being shown what subscribing costs.
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

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
  return {
    title: `Subscribe to ${pub.name} — all.haus`,
    description: pub.tagline || `Subscribe to ${pub.name} on all.haus`,
  }
}

export default async function SubscribePage({ params }: { params: { slug: string } }) {
  const pub = await getPublication(params.slug)
  if (!pub) return notFound()

  return (
    <PublicPage>
      <WorkspacePaneRedirect overlay="surface" params={{ surface: `/pub/${params.slug}/subscribe` }} />
      <PublicationMasthead pub={pub} />
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-14 pb-20">
        <PubSubscribeTerms
          name={pub.name}
          monthlyPence={pub.subscription_price_pence ?? 0}
          annualDiscountPct={pub.annual_discount_pct ?? 0}
        />
      </div>
    </PublicPage>
  )
}
