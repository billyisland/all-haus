'use client'

import type { ReactNode } from 'react'
import { ABOUT_HEADLINE, ABOUT_TERMS_INTRO, aboutSections } from '../../content/about'
import type { PublishedFigures } from '../../lib/published-figures'
import { PublicShell } from '../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../components/public/PublicVessel'
import { GAP, PAD, WALL, usePublicPalette } from '../../components/public/palette'

// =============================================================================
// About.
//
// STYLING, REDESIGNED 2026-07-25. It was already chromeless but pre-restyle
// throughout: a `max-w-article` column on a white page, `font-sans` body copy
// where `/` uses mono prose, a 4xl serif "all.haus" standing in for the lockup,
// `slab-rule-4` dividers between sections, a centred ∀ dingbat above the fold
// line, and a `btn-accent` CTA at the foot. It now uses the same chassis as
// every other public page: bone floor, single-wall ⊔, cards on the interior.
//
// THE DIVIDERS ARE GONE because the cards do that work — a gap between two
// cards on the interior ground already reads as a section break, and stacking a
// 4px slab on top of it says the same thing twice. This is the same reasoning
// that took the divider off NavRow.
//
// THE CTA IS GONE for the reason LandingVessel's was: the waiting-list button
// lives once, in the nav row, where it is on screen for the whole page rather
// than only at the foot of it. A second copy at the end of the prose said the
// same words to the same destination.
//
// The ∀ dingbat is gone for the same reason it left `/`: the mark appears once
// per screen, in the lockup, where it is also a link home.
//
// ─────────────────────────────────────────────────────────────────────────────
// COPY, REWRITTEN 2026-07-25 — READERS-FIRST. THIS IS THE PART TO READ BEFORE
// EDITING.
//
// The page shipped writer-first: "A place to write, publish and get paid",
// then "Writers post Articles… Readers follow for free". That was the old
// positioning. `/` has since moved to readers-first and its metadata went with
// it; About was the last surface still leading with the author. Every FACT
// below is carried over from the previous copy unchanged — the platform's cut, the
// starting credit, the Tab, the Stripe settlement, the key pair in the
// locker, the Articles/Notes distinction. Nothing new is claimed. What changed
// is the order of address: the reader is the subject of the first three
// paragraphs and the writer arrives as someone the reader is paying, which is
// also the actual direction the money runs.
//
// The feed paragraph reuses `/`'s approved framing rather than paraphrasing it,
// so a visitor who reads both doesn't meet two accounts of the same feature.
//
// THE WORDS THEMSELVES LIVE IN `content/about.ts`, which modernhaus's About
// renders too — edit them there. The cut and the allowance are no longer typed:
// both are dials, read by whoever renders this (`figures`) and interpolated
// there; null drops the number from the sentence.
//
// The metadata in ./page.tsx MUST be kept in step with this — it still carried
// the writer-first description at the time of the restyle.
// =============================================================================

export function AboutContent({
  figures,
  inOverlay = false,
}: {
  figures: PublishedFigures | null
  inOverlay?: boolean
}) {
  const cards = (
    <>
      <PublicCard>
        <PublicTitle size={30}>{ABOUT_HEADLINE}</PublicTitle>
      </PublicCard>

      {aboutSections(figures).map((section, i) => (
        <PublicCard key={i}>
          {section.heading && (
            <div style={{ marginBottom: 14 }}>
              <PublicTitle as="h2" size={20}>
                {section.heading}
              </PublicTitle>
            </div>
          )}
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: GAP + 8 }}
          >
            {section.paragraphs.map((paragraph, j) => (
              <PublicBody key={j}>{paragraph}</PublicBody>
            ))}
          </div>
        </PublicCard>
      ))}

      {/* THE FOUR DOCUMENTS, from the one public page that explains the
          platform. There is no footer to put them in — the register bans
          bottom chrome — and the nav bar holds the single accent, so About is
          where a visitor who wants the terms before signing up can find them.
          NEW TAB in both registers: in the overlay a same-tab navigation is
          the escape the Glasshouse rules forbid, and having one behaviour
          rather than two is the two-registers rule (a seam, not a fork). */}
      <PublicCard>
        <div style={{ marginBottom: 14 }}>
          <PublicTitle as="h2" size={20}>
            The terms
          </PublicTitle>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          <PublicBody>{ABOUT_TERMS_INTRO}</PublicBody>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-text"
            >
              Terms of Service
            </a>
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-text"
            >
              Privacy Policy
            </a>
            <a
              href="/reader-terms"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-text"
            >
              Reader Terms
            </a>
            <a
              href="/writer-agreement"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-text"
            >
              Writer Agreement
            </a>
          </div>
        </div>
      </PublicCard>
    </>
  )

  // TWO REGISTERS, ONE SET OF CARDS (2026-09-04). The standalone page keeps its
  // public chassis — bone floor, the fitted single-wall ⊔, cards on the
  // interior. In the workspace the GLASSHOUSE is the container: AboutOverlay
  // draws the ⊓ at the vessel's own 8px wall with the pane bar as its thick
  // top, so a second frame in here would be a vessel inside a vessel, which is
  // what the pane looked like before. Only the chassis is switched; the cards
  // are the same components in both, per the two-registers rule (web/CLAUDE.md).
  if (inOverlay) return <AboutPaneInterior>{cards}</AboutPaneInterior>

  return (
    <PublicShell measure="prose">
      <PublicVessel>{cards}</PublicVessel>
    </PublicShell>
  )
}

// The pane register's interior: the ⊓'s ground, with the cards inset past the
// walls the Glasshouse draws in the pane's edge gutter (WALL + PAD, the same
// arithmetic as ProfileChrome's PROFILE_INSET — the frame costs the content no
// width, so the content has to clear it or the wall lands on a card). Padding
// sits on this scrolling column rather than on the pane, so the interior
// padding TRAVELS WITH THE CARDS — the vessel rule PublicVessel follows too.
// The palette is whatever the pane provided (globalContentPalette, un-islanded).
function AboutPaneInterior({ children }: { children: ReactNode }) {
  const palette = usePublicPalette()

  return (
    <div
      style={{
        background: palette.interior,
        minHeight: '100%',
        padding: WALL + PAD,
        display: 'flex',
        flexDirection: 'column',
        gap: GAP,
      }}
    >
      {children}
    </div>
  )
}
