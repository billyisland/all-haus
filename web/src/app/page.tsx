import type { Metadata } from 'next'
import HomeRedirect from '../components/layout/HomeRedirect'
import { LandingVessel, type Figure } from '../components/landing/LandingVessel'

const TITLE = 'all.haus — No one should own the public square.'

// This is what a shared link and a search result show — edit it when you edit
// the page copy below, the way about/page.tsx says to.
//
// Readers-first, 2026-07-31. The previous text opened "A writing platform on
// Nostr", which was the writer-first positioning the BODY of this page had
// already left and `/about` was corrected off on 2026-07-25 — about/page.tsx's
// own comment claimed `/` had made that move, and it had not. It also led on
// Nostr, which this page deliberately puts LAST (third proposition, final
// paragraph): the protocol is the mechanism, not the pitch.
//
// Named networks rather than the abstract claim, because the concrete thing is
// what a stranger can act on, and "rules you set, not rules set on you" is
// lifted from PROSE[0] so the snippet and the page say the same words.
//
// KEEP IT UNDER ~160 CHARACTERS (this is 159). Search results truncate around
// there, and the tail is where "pay the writer per piece" sits — the whole point
// of the sentence — so an overrun deletes exactly the part worth keeping. That
// is what cost the phrase "from across the open web" its middle two words.
const DESCRIPTION =
  'Build feeds from the open web — Bluesky, Mastodon, RSS — sorted by rules you set, not rules set on you. Read what’s worth reading and pay the writer per piece.'

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

const HEADLINE =
  'all.haus is a writing platform dedicated to three radical propositions:'

const PROPOSITIONS = [
  'No one should own the public square',
  'Keeping up shouldn’t mean being farmed',
  'Writing is work and deserves to be paid as such',
]

const PROSE = [
  'Build omnivorous feeds that pull the whole open social web into one place — Bluesky, Mastodon, Substack, plain old RSS and more. Sort them with rules you set rather than rules set on you. No dopamine hacks, no algorithm optimised for pointless, endless scrolling. A feed is a tool: you need the right one for each job. At all.haus you can create as many as you like.',
  'Read what’s worth reading and pay a few pence for it. You don’t have to subscribe or make financial commitments you’ll forget to cancel. The money goes to whoever wrote the piece, on terms they set.',
  'The whole thing runs on Nostr: an open protocol with no company behind it, no servers to seize, and no owner to sell it to someone worse.',
]

// The showcase below the sell text. These were three `.webp` viewport captures
// under web/public/landing; they are now COMPONENTS (components/landing/demos),
// built from the same palette tokens as the live site. See the long note in
// LandingVessel for why, and for the register each demo is tuned to.
//
// WHAT STAYS HERE IS THE COPY. `caption` is the visible claim under the demo;
// `description` is what a screen reader gets in place of seeing it, and it
// inherits the old `alt` discipline — describe what is actually shown, and keep
// it honest about what the demo does and does not demonstrate. The demos
// themselves are `aria-hidden`: they are div reconstructions, and announced they
// would read as a wall of invented bylines and prices.
//
// THE DEMOS' OWN CONTENT IS INVENTED — bylines, publications, handles and post
// bodies alike (see the note in CanvasDemo). The captures they replaced held
// real posts by real people; retyped as markup on a page that is selling
// something, a real name is a claim we have no right to make. Keep these
// descriptions free of real ones too. The protocol labels are the exception, and
// must stay literally true: they ARE the argument.
//
// ORDER FOLLOWS THE PROSE ABOVE: feeds, then payment, then the protocol — so a
// visitor meets each demo having just read the paragraph it illustrates. The
// Nostr paragraph has no demo, because an open protocol has no screen.
const FIGURES: Figure[] = [
  {
    key: 'canvas',
    caption: 'Feeds are objects on a canvas. Size them, stack them, turn them sideways, copy them, share them, hide them, delete them',
    description:
      'Four all.haus feeds arranged on one canvas, each framed in a different colour and numbered. A wide one fills the left, its top post carrying a photograph of a city skyline at dusk; below it a fourth feed runs sideways, its cards continuing off the right-hand edge. On the right, a narrow feed of headlines alone sits above a second narrow feed of short posts.',
  },
  {
    key: 'omnivore',
    caption: 'Bluesky, Mastodon, Nostr, RSS and more — bring them all together in one place',
    description:
      'A single all.haus feed in close-up. Four posts sit in one column in the same card style, each labelled with where it came from: a film review from RSS, a Bluesky post quoting a newspaper’s reporting, a Nostr note written at four in the morning, and a paid essay from RSS.',
  },
  {
    key: 'reader',
    caption: 'Secure cryptographic paywall, no subscription required. Pay a few pence to read the one piece you’re actually interested in',
    description:
      'A reading pane floating over a blurred workspace of feeds. Inside it an investigative essay, titled and bylined to a small political review, breaks off a few lines in at a “Keep reading” panel: the price, forty pence, then a button to continue and a link to add a payment card, with a monthly subscription to the same review offered underneath as the alternative.',
  },
]

export default function HomePage() {
  return (
    // No topbar: every route is chromeless now, and the one piece of chrome a
    // visitor meets is the nav row LayoutShell mounts at the foot of the
    // viewport. A visitor meets the member grammar — bone floor, one ⊔ vessel
    // at the 8px lattice, cards — with none of the feed furniture that grammar
    // usually carries. See LandingVessel for what is deliberately absent.
    //
    // AN APP SHELL, NOT A SCROLLING DOCUMENT. The page is a `100dvh` flex column
    // pinned to the viewport (`overflow: hidden`): the vessel area fills the
    // space above the nav row, the vessel fills that area, and the card column
    // scrolls INSIDE the vessel. Nothing scrolls at the document level, so the
    // whole vessel is always on screen and the mobile URL-bar rubber-band (which
    // the earlier document-scroll layout suffered) cannot happen. dvh, not vh —
    // `100vh` is the large (URL-bar-hidden) viewport on mobile.
    //
    // `/` KEEPS ITS OWN CHASSIS rather than moving onto PublicShell, and this is
    // the same exception that gives it the doubled wall: it is the only public
    // page whose vessel IS the page, at the prose measure, tuned to its own
    // headroom. PublicShell serves the pages that ask the visitor for something.
    // What `/` no longer owns is the ROW — that was `LandingNavRow`, an in-flow
    // 56px band at the end of this column, now superseded by the fixed
    // `PublicNavRow` LayoutShell mounts on every non-workspace route. The space
    // it used to occupy in the flow is reserved here instead, as
    // `--ah-row-band` (NAV_ROW_H + GRID) of bottom padding — which comes to
    // exactly what the in-flow row plus the vessel area's old 8px bottom
    // padding did, so nothing moves.
    //
    // The floor is `--ah-bone`, a neutral slug, so it inverts with the global
    // toggle. It is also the vessel's own interior colour under `basic`, which
    // is the point of choosing that colourway here: the walls read as ink rules
    // laid on a continuous ground rather than as a box drawn around content.
    // Painting it on THIS element — the full 100dvh, with the band inside as
    // padding — is what keeps the band's clearance above the row bone rather
    // than letting `body` show through it.
    <div
      style={{
        background: 'var(--ah-bone)',
        height: '100dvh',
        paddingBottom: 'var(--ah-row-band, 0px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <HomeRedirect />

      {/* Vessel area — fills all space above the nav row's reserved band and
          centres the column. On desktop its side padding is the bone floor
          showing around the vessel; ON MOBILE THAT MARGIN GOES and the vessel
          runs the full viewport width, which is why the padding lives in
          `.ah-landing-area` (globals.css §1c) rather than inline: the page is
          SSR'd, so the switch has to be a media query. No bottom padding
          either way — the band on the parent carries it. */}
      <div
        className="ah-landing-area"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            maxWidth: 720,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <LandingVessel
            headline={HEADLINE}
            propositions={PROPOSITIONS}
            prose={PROSE}
            figures={FIGURES}
          />
        </div>
      </div>
    </div>
  )
}
