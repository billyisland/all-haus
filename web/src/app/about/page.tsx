import type { Metadata } from 'next'
import { AboutContent } from './AboutContent'
import {
  PUBLISHED_FIGURES_PATH,
  parsePublishedFigures,
  type PublishedFigures,
} from '../../lib/published-figures'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

// The cut and the allowance the copy names are dials (content/about.ts), read
// here behind `revalidate`, so the gateway sees about one fetch per window and
// a retuned dial reaches the page within five minutes.
//
// A FAILED READ RENDERS THE PAGE, NOT error.tsx. This is the one departure from
// "an outage renders as an outage" (web-public.md), and it is deliberate: the
// page is About, not the figures, and the null copy drops each number rather
// than claim a wrong one, so nothing it says is false. It also has to survive
// `next build`, which prerenders this page with no gateway to ask; the first
// revalidation after boot fills the numbers in.
async function getFigures(): Promise<PublishedFigures | null> {
  try {
    const res = await fetch(`${GATEWAY}/api/v1${PUBLISHED_FIGURES_PATH}`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) {
      console.warn(`about: published figures answered ${res.status}; the copy drops its numbers`)
      return null
    }
    return parsePublishedFigures(await res.json())
  } catch (err) {
    console.warn('about: published figures unreachable; the copy drops its numbers', err)
    return null
  }
}

// Metadata kept in step with AboutContent's readers-first rewrite (2026-07-25).
// The previous description ("A place to write, publish and get paid. Own your
// identity, build a profile on your terms, find an audience that pays.") was
// the writer-first positioning `/` has already left. If you edit the page copy,
// edit this too — it is what a shared link shows.
const TITLE = 'About — all.haus'
const DESCRIPTION =
  'A reading platform where you buy what you read, direct from whoever wrote it: omnivorous channels sorted by rules you set, and a few pence a piece.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: 'website',
    siteName: 'all.haus',
  },
  twitter: {
    card: 'summary',
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default async function AboutPage() {
  return <AboutContent figures={await getFigures()} />
}
