import { Fragment } from 'react'
import type { LegalDoc } from '../../content/legal/generated'
import { ABOUT_HEADLINE, ABOUT_TERMS_INTRO, aboutSections } from '../../content/about'
import type { PublishedFigures } from '../../lib/published-figures'
import { stripOrnament } from '../html-pass'

// =============================================================================
// modernhaus — the home page, About and the four legal texts (§D2.3, E1).
// =============================================================================

export const LEGAL_LINKS = [
  { slug: 'terms', label: 'Terms of Service' },
  { slug: 'privacy', label: 'Privacy Policy' },
  { slug: 'reader-terms', label: 'Reader Terms' },
  { slug: 'writer-agreement', label: 'Writer Agreement' },
] as const

function LegalList() {
  return (
    <ul>
      {LEGAL_LINKS.map((l) => (
        <li key={l.slug}>
          <a href={`/modernhaus/${l.slug}`}>{l.label}</a>
        </li>
      ))}
    </ul>
  )
}

/**
 * `/modernhaus`, signed out. A member's home is the feed index instead
 * (§D2.9 Q2; `pages/feeds.tsx`).
 */
export function HomePage(_props: { viewer: null }) {
  return (
    <>
      <p>{ABOUT_HEADLINE}</p>
      <p>This is the plain version of the site: no scripts, no styling, just the pages.</p>
      <ul>
        <li>
          <a href="/modernhaus/about">About</a>
        </li>
        <li>
          <a href="/modernhaus/search">Search</a>
        </li>
        <li>
          <a href="/modernhaus/signin">Sign in</a>
        </li>
      </ul>
      <h2>The terms</h2>
      <LegalList />
    </>
  )
}

export function AboutPage({ figures }: { figures: PublishedFigures | null }) {
  return (
    <>
      <p>{ABOUT_HEADLINE}</p>
      {aboutSections(figures).map((section, i) => (
        <Fragment key={i}>
          {section.heading && <h2>{section.heading}</h2>}
          {section.paragraphs.map((p, j) => (
            <p key={j}>{p}</p>
          ))}
        </Fragment>
      ))}
      <h2>The terms</h2>
      <p>{ABOUT_TERMS_INTRO}</p>
      <LegalList />
    </>
  )
}

/**
 * A legal text. Its HTML is the generated module's, sanitised at build; the
 * ornament pass only drops its `class` hooks, which name a stylesheet this
 * register does not have.
 */
export function LegalPage(props: { doc: LegalDoc }) {
  return (
    <>
      <p>{`Version ${props.doc.version}`}</p>
      <div dangerouslySetInnerHTML={{ __html: stripOrnament(props.doc.html) }} />
    </>
  )
}
