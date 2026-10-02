import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { NativeProfileBody } from '../../components/profile/NativeProfileBody'
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

// ONLY A 404 IS AN ABSENCE (CA-E1, 2026-09-29). This returned null on any
// non-2xx, and the page turned null into `notFound()` — so a gateway 5xx or an
// nginx 502 rendered the 404 page, telling a reader the writer did not exist
// while the platform was the thing that was down. Anything else THROWS to
// `app/error.tsx`, which says so and offers a retry; and a throw stores
// nothing under `revalidate`, where a cached null would have kept the false
// 404 for a minute after the outage ended.
async function getWriter(username: string): Promise<WriterProfile | null> {
  const res = await fetch(`${GATEWAY}/api/v1/writers/${encodeURIComponent(username)}`, {
    next: { revalidate: 60 },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Writer lookup failed: ${res.status}`)
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
  //
  // `barGround` is bone all the same — the same colour the bar already falls
  // back to. It is not about the bar here but about the 8px clearance band
  // under it, which `ground={false}` leaves transparent: it fell through to
  // `body` and drew a white (dark: ink-900) stripe between the bone bar and
  // this page's bone floor. See PublicPage.
  return (
    <PublicPage ground={false} barGround="var(--ah-bone)">
      <NativeProfileBody
        username={params.username}
        writer={writer}
        minHeight="100dvh"
      />
    </PublicPage>
  )
}
