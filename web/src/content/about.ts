// =============================================================================
// About — the words, in one home for both registers.
//
// The full site's About (`app/about/AboutContent.tsx`, a client component in
// the public register) and modernhaus's (`/modernhaus/about`, bare HTML) render
// the SAME text. It lives here, outside both, because modernhaus cannot import
// a `'use client'` file and a second copy of a public page drifts invisibly.
// The editorial note on the copy (readers-first, 2026-07-25) is in
// AboutContent's header, and its metadata twin is in `app/about/page.tsx`.
// =============================================================================

import { allowancePounds, feePercent, type PublishedFigures } from '../lib/published-figures'

export const ABOUT_HEADLINE = 'all.haus is a reading platform where you buy what you read, from whoever wrote it.'

// THE FIGURES ARE DIALS, NOT WORDS. The platform's cut and the new account's
// allowance are `platform_fee_bps` and `free_allowance_pence`; both sentences
// interpolate them from `GET /published-figures` (lib/published-figures.ts).
// With no figures (the read failed, or has not landed) each sentence drops its
// number instead of guessing one. Never type either figure back in.
export interface AboutSection {
  heading?: string
  paragraphs: string[]
}

export function aboutSections(figures: PublishedFigures | null): AboutSection[] {
  const cut = figures
    ? `charging ${feePercent(figures.platformFeeBps)} of what you earn to cover running costs`
    : 'charging a share of what you earn to cover running costs'
  const allowance = figures
    ? `a ${allowancePounds(figures.freeAllowancePence)} reading allowance`
    : 'a reading allowance'
  return [
    {
      paragraphs: [
        'Filter the whole open social web — Bluesky, Mastodon, Substack, RSS and more — into personalised channels that run on rules you set rather than rules set on you. Make as many channels as you like: a content stream is a tool, and different jobs call for different approaches.',
        'When something is worth reading, pay a few pence to unlock it. No bundle, and nothing to forget to cancel. If you find yourself reading someone often, subscribe to them monthly and unlock everything they put behind a paywall — but you never have to.',
        'Charges run up on a Tab, as they would at a bar, and settle through Stripe. You are buying from the writer; all.haus collects on their behalf and passes the money on, in batches, once the sum is big enough that transaction fees won’t eat it.',
      ],
    },
    {
      heading: 'If you write as well as read',
      paragraphs: [
        'You post Articles, which can be paywalled, and Notes, which can’t, on terms you set. People follow you for nothing and pay only for the pieces they actually open — so what you’re paid for is the writing, not the attention. For now, writing is by application: choose Apply to write from the ∀ menu, and we’ll email you when you’re in.',
      ],
    },
    {
      heading: 'Built on open ground',
      paragraphs: [
        'all.haus runs on Nostr, an open-source, peer-to-peer messaging protocol popular with privacy advocates, libertarians and Bitcoin enthusiasts. You don’t need to be any of those things to like what it makes possible.',
        `By default, all.haus hosts your content and sells it on your behalf, as your agent, ${cut}. But your account, content, follows and reading permissions are all portable. Your identity is a cryptographic key pair, kept in a secure locker all.haus can’t read, and you can move it to another custodian, a browser extension or a piece of paper whenever you like. If you tire of all.haus, leave for another host — or run your own — and take your followers, your receipts and your self-respect with you.`,
      ],
    },
    {
      heading: 'You don’t need to think about any of that',
      paragraphs: [
        `Log in with Google if you like, and use what looks and feels like an ordinary web app. Your account comes with ${allowance} — a gift from the writers, charged to nobody. When it runs out, add a card and carry on, safe in the knowledge that the account really is yours.`,
      ],
    },
  ]
}

export const ABOUT_TERMS_INTRO =
  'The Terms of Service and the Privacy Policy apply from the moment you have an account. Two more cover money: the Reader Terms, which you accept when you register a card, and the Writer Agreement, which you accept when you first sell paid access to your writing.'
