import { paletteFor, type VesselPalette } from '../../workspace/tokens'
import { DemoVessel, DemoPost, DemoByline, DemoTitle, DemoBody, DemoTag } from './primitives'

// =============================================================================
// ReaderDemo — the reading pane ON THE GLASSHOUSE. Supersedes GateDemo.
//
// WHAT WAS WRONG WITH THE BARE GATE. Shown on plain card ground it read as
// TEXT THAT HAD GONE WRONG — a paragraph trailing off into a fade, then a price,
// then two buttons, floating on nothing. Every part of the visual grammar that
// makes a paywall legible as a paywall was missing, because that grammar is not
// in the gate: it is in the SITUATION the gate appears in. A reader recognises a
// paywall by the shape of a pane held over an interrupted background, and there
// was no background and no pane.
//
// So the demo now shows the whole Glasshouse figure, which is the canonical
// "surface opened over the workspace" primitive:
//
//   FLOOR — four feed vessels in four colourways, blurred and desaturated. This
//           does double duty: it supplies the interrupted background the gate
//           needs, and it quietly restates the canvas argument from the demo
//           above, so a visitor sees the reader as something that opens OVER
//           their feeds rather than as a separate place they navigate to.
//   SCRIM — bone-bright at 0.72 (ink-925 at 0.74 in dark), matching `.gh-scrim`.
//   PANE  — glasshouse ground, lifted by an elevation shadow ALONE with no top
//           edge, per GLASSHOUSE-AND-PALETTE-ADR §III.2, carrying the drag grip
//           and the ✕. Inside it: the article, then the gate.
//
// THE BLUR IS A `filter` ON THE FLOOR, NOT `backdrop-filter` ON THE SCRIM. The
// real `.gh-scrim` uses backdrop-filter because it sits over a live, scrolling
// workspace it cannot know the contents of. Here the floor is inert markup that
// exists only to be blurred, so blurring it directly is cheaper, avoids the
// backdrop-filter containment bugs that bite inside transformed or clipped
// ancestors, and renders identically. Do NOT "correct" this to backdrop-filter
// for consistency with the real scrim — the situations are not the same.
//
// THE PANE'S MARGIN REPLACES THE OLD `INSET`. The previous version pulled the
// gate in from the card edge so it would read as a specimen rather than as the
// page's own prose. That signal is now carried structurally: a lifted pane over
// a blurred field cannot be mistaken for the page's content, so the inset is no
// longer doing separate work — it is just the pane's margin, which is what it
// looked like it was all along.
//
// SIZING, unchanged in principle: one base font-size on the root, everything
// inside in `em`, so the whole figure moves as a unit. It stays a clear step
// below the page's 17px prose, because the article text inside the pane is
// filler and a visitor who starts reading it gets nothing for it.
//
// THE BYLINES AND BODIES ON THE FLOOR ARE INVENTED — see the note in CanvasDemo,
// whose invented world this shares. It matters even here, where the floor is
// blurred to texture: blur is a rendering choice, and the names would still be
// in the markup, in the DOM, and in view of anyone who reads it. The floor cards
// are also DISTINCT from the other two demos' cards, per that same note; only
// the article in the pane is repeated, and deliberately.
//
// AND THE FLOOR CARRIES NO HALCYON CARD AT ALL. The pane is the story's fifth
// and last appearance, so what shows through the blur beside it is deliberately
// four other things — a vote, the ice, the pound, a lecture on moss with a
// waiting list. The gate is more legible for it: a paywall over the one story
// the page has been building, on a floor that visibly holds everything else, is
// the whole argument in a single figure. A floor of further Halcyon coverage
// would have made the product look like a single-subject wire.
//
// THE ARTICLE IS THE OMNIVORE DEMO'S PAID CARD. Ellis Marchetti's "The men who
// bought the lights" is priced in the feed above and gated here, and Third Rail
// is the publication the subscription line offers — so a visitor is asked to pay
// for a piece they have already read the opening of and been told the price of,
// rather than for an anonymous slab of filler. If either end of that pairing is
// rewritten, rewrite the other.
//
// AND THE PIECE HAS TO BE ONE A STRANGER WOULD PAY FORTY PENCE FOR. The whole
// figure is an argument about willingness to pay, so a gate closing over a
// gentle literary reminiscence demonstrates nothing except that the gate works.
// It closes over the story the rest of the page has spent three demos building
// — the Halcyon grid sale — at the paragraph where the writer says what they
// have and stops.
//
// WHY NOT REUSE PaywallGate. It takes fifteen props about a real reader's real
// balance, fires an IntersectionObserver, POSTs a nudge-shown event, and renders
// copy branched on login state and remaining credit. Mounting that on `/` to
// show a stranger what a paywall looks like would be absurd. This is the one
// branch of its copy that states the argument — used your credit, pay per read,
// subscription as the alternative — frozen as markup.
// =============================================================================

interface FloorCard {
  name: string
  time: string
  title?: string
  body: string
  tag: string
  paid?: boolean
}

const FLOOR: { scheme: 'basic' | 'summer' | 'autumn' | 'spring'; cards: FloorCard[] }[] = [
  {
    scheme: 'basic',
    cards: [
      {
        name: 'Tobias Wren',
        time: '5d',
        title: 'How to lose a vote you have already won',
        body: 'Nobody loses a count they have done. What follows is three weeks of a government declining to do one…',
        tag: 'via RSS',
      },
      { name: 'Halloran', time: '6h', body: 'Somebody has left a piano on the seafront. Three days on it is still in tune, and there is a queue.', tag: 'via Bluesky' },
    ],
  },
  {
    scheme: 'summer',
    cards: [
      { name: 'Deep Field', time: '1h', body: 'The ice is going from underneath, and the models are still arguing about the surface…', tag: 'via Nostr' },
      { name: 'Fenwick Wire', time: '2h', body: 'Best week for the pound in two years, and every desk I called used the same word: temporarily…', tag: 'via RSS' },
    ],
  },
  {
    scheme: 'autumn',
    cards: [
      {
        name: 'Ines Bergqvist',
        time: '1h',
        body: 'Went to a lecture on moss expecting six people. Two hundred and forty turned up and there is now a waiting list. For moss.',
        tag: 'via Bluesky',
      },
    ],
  },
  {
    scheme: 'spring',
    cards: [
      { name: 'Marguerite Oyelaran', time: '5d', paid: true, title: 'The year in films nobody would fund', body: 'Twelve of them, one desk, and the reason none will reach a cinema near you…', tag: 'via RSS' },
    ],
  },
]

// THE PANE'S TEXT IS THE NEUTRAL TOKENS, NOT THE FEED PALETTE — and until
// 2026-07-29 it was the palette, which made the entire paywall figure unreadable
// in dark mode. The pane is a Glasshouse: `--ah-glasshouse`, and the landing
// vessel is a LIGHT ISLAND, so that slug resolves canonical WHITE in both modes.
// The `palette` prop, meanwhile, is `paletteFor('basic', dark)` — under the dark
// toggle its `cardTitle`/`cardStandfirst` are the LIGHT ends of the ramp, built
// for a dark card. Title, prose, "Keep reading", the price and the Subscribe
// button were all painting near-white on white; only the crimson button
// survived. Neutral slugs are the fixed-light-surface rule (CLAUDE.md, the
// Glasshouse exemption) and they are islanded here, so they resolve canonical in
// both modes. The FLOOR keeps the palette — those are feed cards, and they are
// meant to follow the toggle.
const PANE_INK = 'var(--ah-ink)'
const PANE_MUTED = 'var(--ah-grey-600)'
const PANE_ACCENT = 'var(--ah-crimson)'

export function ReaderDemo({ palette, dark }: { palette: VesselPalette; dark: boolean }) {
  const rule = { height: 2, background: PANE_ACCENT, margin: '1.4em 0' }

  return (
    <div className="ah-demo-reader" style={{ background: palette.interior }}>
      {/* The workspace continuing behind. aria-hidden and inert: it is texture. */}
      <div className="ah-demo-reader-floor" aria-hidden="true">
        {FLOOR.map((column) => {
          const p = paletteFor(column.scheme, dark)
          return (
            <DemoVessel key={column.scheme} palette={p}>
              {column.cards.map((card, i) => (
                <DemoPost key={i} palette={p} padding="0.75em 0.85em">
                  <DemoByline palette={p} name={card.name} time={card.time} paid={card.paid} />
                  {card.title ? <DemoTitle palette={p}>{card.title}</DemoTitle> : null}
                  <DemoBody palette={p}>{card.body}</DemoBody>
                  <DemoTag palette={p}>{card.tag}</DemoTag>
                </DemoPost>
              ))}
            </DemoVessel>
          )
        })}
      </div>

      <div className="ah-demo-reader-scrim" aria-hidden="true" />

      <div className="ah-demo-reader-pane" style={{ background: 'var(--ah-glasshouse)' }}>
        {/* The drag grip — the discoverable affordance for a pane that is
            draggable by any empty part of itself. Included because it is what
            tells a visitor this thing FLOATS. */}
        <div className="ah-demo-grip" aria-hidden="true" />
        <div className="ah-demo-close" aria-hidden="true" style={{ color: PANE_MUTED }}>
          &times;
        </div>

        {/* THE PIECE HAS A NAME, and before it did the gate was asking a
            stranger for forty pence over four lines of untitled prose — nothing
            on the pane said what was being bought, so the only thing the figure
            could demonstrate was the interruption. A title and a byline cost two
            lines and turn it into an article somebody might want. The title is
            the one the omnivore demo prices above; the publication is the one
            the subscription line offers below, so the three parts of the payment
            argument are about the same piece of writing. */}
        <div
          className="font-serif"
          style={{ fontSize: '1.65em', lineHeight: 1.15, fontWeight: 600, color: PANE_INK, marginBottom: '0.45em' }}
        >
          The men who bought the lights
        </div>
        <div
          className="font-mono"
          style={{
            fontSize: '0.72em',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: PANE_MUTED,
            marginBottom: '1.3em',
          }}
        >
          Ellis Marchetti &middot; Third Rail
        </div>

        <div
          className="font-serif ah-demo-art"
          style={{ color: PANE_INK, ['--ah-demo-pane' as string]: 'var(--ah-glasshouse)' }}
        >
          Halcyon did not buy a power company. It bought the switch. Everything
          else &mdash; the four holding companies, the ninety days between a
          signature and a seat on the board, the eleven refused requests &mdash;
          is the paperwork you generate when you already know how the thing ends.
          I have spent six weeks with those documents. The striking part is not
          the theft. It is how bored everyone involved appears to have been by
          it.
        </div>

        <div style={rule} />

        <div style={{ textAlign: 'center' }}>
          <div
            className="font-serif"
            style={{ fontSize: '1.45em', lineHeight: 1.2, fontWeight: 500, color: PANE_INK, marginBottom: '0.5em' }}
          >
            Keep reading
          </div>
          <p
            className="font-serif"
            style={{ fontSize: '0.92em', lineHeight: 1.5, color: PANE_MUTED, maxWidth: '26em', margin: '0 auto 1.3em' }}
          >
            You&rsquo;ve used your free reading credit. Add a payment card to keep
            reading &mdash; you only pay for what you read.
          </p>
          <div
            className="font-serif"
            style={{ fontSize: '2.1em', lineHeight: 1, color: PANE_INK, marginBottom: '0.6em' }}
          >
            &pound;0.40
          </div>

          {/* Inert. See the note in LandingFigure: the demos are aria-hidden
              reconstructions, so these are divs, not buttons — a control that
              does nothing is worse than no control. */}
          <div
            aria-hidden="true"
            style={{ display: 'inline-block', background: PANE_ACCENT, color: 'var(--ah-white)', padding: '0.85em 2em', fontSize: '1em', lineHeight: 1 }}
          >
            Continue reading
          </div>
          <div aria-hidden="true" style={{ fontSize: '0.95em', color: PANE_INK, marginTop: '1em' }}>
            Add a payment card &rarr;
          </div>

          {/* The subscription alternative is separated by its own room, not by a
              rule. This bundle, like the one before it, drew a one-pixel divider
              here — which the house never renders, and which only the tripwire's
              bare-`1` pattern catches, since a numeric style value picks up its
              unit at render. Whitespace does the same work and is the sitewide
              answer. */}
          <div style={{ fontSize: '0.92em', color: PANE_MUTED, margin: '3em 0 1em' }}>
            Or subscribe to Third Rail for{' '}
            <strong style={{ fontWeight: 500 }}>&pound;5.00/mo</strong> to read everything
          </div>
          <div
            aria-hidden="true"
            style={{ display: 'inline-block', background: PANE_INK, color: 'var(--ah-glasshouse)', padding: '0.8em 1.9em', fontSize: '0.95em', lineHeight: 1 }}
          >
            Subscribe
          </div>
        </div>

        <div style={rule} />
      </div>
    </div>
  )
}
