import type { Metadata } from 'next'
import { LegalDocument } from '../../components/public/LegalDocument'
import { legalDoc } from '../../content/legal/lookup'

// The document is resolved at module scope, so a slug that is not in the
// generated module fails the BUILD rather than rendering an empty page.
const DOC = legalDoc('reader-terms')

const TITLE = 'Reader Terms — all.haus'
const DESCRIPTION =
  'The terms that apply when you register a payment card on all.haus to read paid content.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: 'website',
    siteName: 'all.haus',
  },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
}

export default function Page() {
  return <LegalDocument doc={DOC} />
}
