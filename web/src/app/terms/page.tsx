import type { Metadata } from 'next'
import { LegalDocument } from '../../components/public/LegalDocument'
import { legalDoc } from '../../content/legal/lookup'

// The document is resolved at module scope, so a slug that is not in the
// generated module fails the BUILD rather than rendering an empty page.
const DOC = legalDoc('terms')

const TITLE = 'Terms of Service — all.haus'
const DESCRIPTION =
  'The agreement between you and Villa Negativa Limited for your use of all.haus.'

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
