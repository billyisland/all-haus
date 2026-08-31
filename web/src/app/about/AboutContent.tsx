'use client'

import { PublicShell } from '../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../components/public/PublicVessel'
import { GAP } from '../../components/public/palette'

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
// below is carried over from the previous copy unchanged — the 8% cut, the £5
// of starting credit, the Tab, the Stripe settlement, the key pair in the
// locker, the Articles/Notes distinction. Nothing new is claimed. What changed
// is the order of address: the reader is the subject of the first three
// paragraphs and the writer arrives as someone the reader is paying, which is
// also the actual direction the money runs.
//
// The feed paragraph reuses `/`'s approved framing rather than paraphrasing it,
// so a visitor who reads both doesn't meet two accounts of the same feature.
//
// The metadata in ./page.tsx MUST be kept in step with this — it still carried
// the writer-first description at the time of the restyle.
// =============================================================================

const HEADLINE = 'all.haus is a reading platform that pays the people you read.'

const SECTIONS: { heading?: string; paragraphs: string[] }[] = [
  {
    paragraphs: [
      'Build omnivorous feeds that pull the whole open social web — Bluesky, Mastodon, Substack, plain old RSS — into one place, and sort them with rules you set rather than rules set on you. A feed is a tool: you need the right one for each job, so you can make as many as you like.',
      'When something is worth reading, pay a few pence to unlock it. No subscription, no bundle, no commitment you’ll forget to cancel. If you read someone often, you can subscribe to them monthly instead and unlock everything they put behind a paywall — but you never have to.',
      'Charges accumulate on a Tab, the way a bar tab does, and settle through Stripe. The money goes to whoever wrote the piece; they’re paid in batches, once the balance is big enough that transaction fees won’t eat it.',
    ],
  },
  {
    heading: 'If you write as well as read',
    paragraphs: [
      'You post Articles, which can be paywalled, and Notes, which can’t. You set your own terms. People can follow you for nothing and pay only for the pieces they actually open, which means the thing you’re being paid for is the writing rather than the attention.',
    ],
  },
  {
    heading: 'Built on open ground',
    paragraphs: [
      'all.haus runs on Nostr, an open-source, peer-to-peer messaging protocol popular with privacy advocates, libertarians and Bitcoin enthusiasts. You don’t need to be any of those things to like what it makes possible.',
      'By default, all.haus hosts your content and manages your payments, taking an 8% cut to cover running costs. But your account, your content, your follows, and your reading permissions are all genuinely portable. Your identity is a cryptographic key pair held in a secure locker that all.haus can’t read. You can move it to another custodian, a browser extension, or a piece of paper whenever you like. If you don’t like what all.haus is doing, leave for another host — or run your own — taking your followers, your payment receipts, and your self-respect with you.',
    ],
  },
  {
    heading: 'You don’t need to think about any of that',
    paragraphs: [
      'Log in with Google if you like, and use what looks and feels like a straightforward web app. Your account comes with £5 of credit to get started. When it runs out, connect a payment method and carry on — safe in the knowledge that your all.haus account is genuinely yours.',
    ],
  },
]

export function AboutContent() {
  return (
    <PublicShell measure="prose">
      <PublicVessel>
        <PublicCard>
          <PublicTitle size={30}>{HEADLINE}</PublicTitle>
        </PublicCard>

        {SECTIONS.map((section, i) => (
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
      </PublicVessel>
    </PublicShell>
  )
}
