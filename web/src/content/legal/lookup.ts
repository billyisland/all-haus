import { LEGAL_DOCS, type LegalDoc } from './generated'

// Deliberately NOT in LegalDocument.tsx, which is `'use client'`: a function
// exported across that boundary is not a function on the server, and a page
// importing one fails at BUILD with `(0, n.f) is not a function` — the error
// naming neither the import nor the boundary. tsc and ESLint both pass on it.

/** The one document with this slug, or a throw naming what is missing. */
export function legalDoc(slug: string): LegalDoc {
  const doc = LEGAL_DOCS.find((d) => d.slug === slug)
  // A build-time failure, deliberately loud: the alternative is a terms page
  // that renders empty, which is a document a member can be asked to accept
  // and cannot read.
  if (!doc) throw new Error(`legal document "${slug}" is not in generated.ts`)
  return doc
}
