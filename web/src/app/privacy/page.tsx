import type { Metadata } from 'next'
import { LegalDocument } from '../../components/public/LegalDocument'
import { legalDoc } from '../../content/legal/lookup'

// The document is resolved at module scope, so a slug that is not in the
// generated module fails the BUILD rather than rendering an empty page.
const DOC = legalDoc('privacy')

const TITLE = 'Privacy Policy — all.haus'
const DESCRIPTION =
  'What all.haus does with information about you: the keys we hold, the messages we can read, and the record we keep of what you read.'

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
