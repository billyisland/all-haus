import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { NativeProfileBody } from '../../components/profile/NativeProfileBody'
import WorkspacePaneRedirect from '../../components/layout/WorkspacePaneRedirect'
import { PublicPage } from '../../components/public/PublicPage'
import type { WriterProfile } from '../../lib/api'

// =============================================================================
// Writer Profile Page — /[username]  (Server Component)
//
// Fetches the writer's profile from the gateway at request time and hands it to
// NativeProfileBody — the ONE body both registers render (PROFILE-PANE-REDESIGN
// -ADR §5.1). The header used to be written inline here, which is precisely how
// three copies of one header came to disagree about the bio's typeface, the
// display name's weight and the counts' voice. `NativeProfileBody` is a client
// component, so it still server-renders: the share/SEO HTML is unchanged.
//
// The register's difference is passed in, not forked: this page has nothing to
// close, so it passes no `onClose` and tier 1 renders no ✕ (D10).
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'
const SITE_URL = process.env.APP_URL ?? 'https://all.haus'

async function getWriter(username: string): Promise<WriterProfile | null> {
  const res = await fetch(`${GATEWAY}/api/v1/writers/${username}`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function generateMetadata({ params }: { params: { username: string } }): Promise<Metadata> {
  const writer = await getWriter(params.username)
  if (!writer) return {}

  const title = `${writer.displayName ?? params.username} — all.haus`
  const description = writer.bio || `Articles by ${writer.displayName ?? params.username} on all.haus`
  const url = `${SITE_URL}/${params.username}`

  return {
    title,
    description,
    alternates: {
      types: {
        'application/rss+xml': `${SITE_URL}/rss/${params.username}`,
      },
    },
    openGraph: {
      title,
      description,
      type: 'profile',
      url,
      siteName: 'all.haus',
      ...(writer.avatar && { images: [{ url: writer.avatar }] }),
    },
    twitter: {
      card: 'summary',
      title,
      description,
    },
  }
}

export default async function WriterProfilePage({ params }: { params: { username: string } }) {
  const writer = await getWriter(params.username)
  if (!writer) return notFound()

  // `ground={false}`: the profile surface paints its own interior and stands
  // its own height (PublicPage's bone floor behind it would be a layer nobody
  // sees, and stacking two full viewports leaves dead scroll at the foot).
  return (
    <PublicPage ground={false}>
      <WorkspacePaneRedirect overlay="profile" params={{ user: params.username }} />
      <NativeProfileBody
        username={params.username}
        writer={writer}
        minHeight="100dvh"
      />
    </PublicPage>
  )
}
