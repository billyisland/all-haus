import type { Metadata } from 'next'
import { AboutContent } from './AboutContent'

// Metadata kept in step with AboutContent's readers-first rewrite (2026-07-25).
// The previous description ("A place to write, publish and get paid. Own your
// identity, build a profile on your terms, find an audience that pays.") was
// the writer-first positioning `/` has already left. If you edit the page copy,
// edit this too — it is what a shared link shows.
const TITLE = 'About — all.haus'
const DESCRIPTION =
  'A reading platform that pays the people you read: omnivorous feeds sorted by rules you set, and a few pence to whoever wrote the thing.'

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

export default function AboutPage() {
  return <AboutContent />
}
