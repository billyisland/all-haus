'use client'

import { PublicShell } from './PublicShell'
import { PublicCard, PublicTitle, PublicVessel } from './PublicVessel'
import { usePublicPalette } from './palette'
import type { LegalDoc } from '../../content/legal/generated'

// =============================================================================
// A legal document, in the public register.
//
// ONE COMPONENT FOR ALL FOUR TEXTS, and there will not be a second: the Terms
// of Service, the Privacy Policy, the Reader Terms and the Writer Agreement
// differ in what they say and in nothing else, so a per-document component
// would be four copies of one chassis drifting apart in a place where "these
// pages look slightly different" reads as "one of them is not the real one".
//
// THE BODY IS RENDERED HTML AND ITS TYPOGRAPHY IS CSS (`.ah-legal-body`,
// globals.css §1a-ter). The markdown was converted at generation time, so
// there is one blob rather than the list of paragraphs About hands to
// PublicBody — the class is PublicTitle's and PublicBody's type expressed as
// element rules, with the two palette-derived inks crossing as custom
// properties for the register's standing SSR reason.
//
// THE VERSION IS ON THE PAGE, in the footer line, because that is the whole
// point of versioning the text: a member who accepted `1.0` has to be able to
// find out what `1.0` said. For the two documents that ARE accepted,
// `web/tests/legal-text.test.ts` pins that string against
// `READER_TERMS_VERSION` / `WRITER_TERMS_VERSION` in `shared`, read out of the
// file — there is no module path between the workspaces, and a version on the
// page that disagrees with the one the server stamps is a record of an
// acceptance of something else. The Terms and the Privacy Policy are accepted
// by nothing, so their version is for the reader alone and has no constant to
// disagree with; it still has to be there, and still has to move with the
// text.
// =============================================================================

export function LegalDocument({ doc }: { doc: LegalDoc }) {
  const palette = usePublicPalette()

  return (
    <PublicShell measure="prose">
      <PublicVessel>
        <PublicCard>
          <div style={{ marginBottom: 18 }}>
            <PublicTitle size={30}>{doc.title}</PublicTitle>
          </div>
          <div
            className="font-mono ah-legal-body"
            style={
              {
                '--ah-legal-ink': palette.cardTitle,
                '--ah-legal-muted': palette.cardStandfirst,
              } as React.CSSProperties
            }
            // The markdown is ours and was sanitised at generation time
            // (rehype-sanitize, web/scripts/gen-legal-texts.ts). The sanitiser
            // stays in that pipeline for the reason it always does: a gate
            // removed because the input is trusted is a gate that is missing
            // the day the input stops being.
            dangerouslySetInnerHTML={{ __html: doc.html }}
          />
        </PublicCard>

        <PublicCard>
          <p
            className="label-ui"
            style={{ color: palette.cardMeta, margin: 0 }}
          >
            {doc.title} · version {doc.version}
          </p>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}

