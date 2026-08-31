import {
  DemoVessel,
  DemoPost,
  DemoByline,
  DemoTitle,
  DemoBody,
  DemoTag,
  DemoQuote,
} from './primitives'
import type { VesselPalette } from '../../workspace/tokens'

// =============================================================================
// OmnivoreDemo — ONE feed column, at a size you can actually read.
//
// This is the demo that most needed rebuilding. Its predecessor was a 1848×1056
// viewport capture shown 640px wide: a 2.9× reduction, which put the app's 15px
// body type at roughly 5px. The four VIA lines — the entire argument — were the
// first thing to dissolve, so the picture proved nothing the caption hadn't
// already asserted.
//
// A SINGLE COLUMN is what fixes it. At the prose measure one feed renders at
// very nearly its true size, so the origin tags read as text rather than as
// grey texture, and a visitor can see that a Bluesky reply, an RSS essay and a
// Nostr note are sitting in one stack, in one card grammar, without being told.
// Four cards, four protocols; the crimson pip on the last one is the only
// forward reference to the payment argument below.
//
// THE FOUR BODIES ARE THE PAGE'S ONLY READABLE COPY, so they carry the weight of
// the mix the pitch is claiming: a critic with an enemy, a reply that turns a
// reported fact into an accusation, somebody at a fish market at four in the
// morning, and a paid essay on the story two of the others are circling. Chatter
// and journalism in one column, which is the argument.
//
// AND THEY HAVE TO BE WORTH READING. These four are the only sentences on `/`
// that a visitor reads at their true size, so they are the demo's real proof:
// a column of gentle literary noticing proves the product collects things nobody
// clicks. Front-page register — a verdict, an accusation, a scene, a stake.
//
// THE FOUR ARE ALSO FOUR MOODS, deliberately, and that is the other half of the
// proof. All four sentences pitched at the same investigative gravity would make
// the product look like a single grim column with four wrappers; the middle two
// are the swing — an accusation, then somebody buying an unidentifiable fish and
// finding it very funny — because a surface that holds only one register does not
// need to hold everything. Light does not mean slight: the fish card is as
// specific and as finished as the accusation is.
//
// THE PAID CARD IS THE PIECE THE READER DEMO OPENS — deliberately, and the one
// post repeated anywhere on the page (see the note in CanvasDemo, which forbids
// the rest). Ellis Marchetti's "The men who bought the lights" is priced here
// and gated there, so a visitor scrolling down meets the same article twice and
// the paywall lands on something they have already been given a reason to want.
//
// SCALE. This runs at the LARGEST base of the three demos, because it is the
// one carrying content the visitor is meant to actually read. See the register
// note in LandingVessel.
// =============================================================================

// Base size lives in globals.css §1d (`.ah-demo-omnivore`): 14.5px desktop,
// 13.5px mobile. It stays the largest of the three at both sizes — it is the
// demo carrying content a visitor is meant to read.

// THE BYLINES AND BODIES ARE INVENTED — see the note in CanvasDemo. It
// matters most here, because this is the demo shown at near-true size and the
// one whose content a visitor is actually meant to read: a real name attached
// to a retyped post is a claim we have no right to make, and a real name
// attached to an invented post is worse. The protocol labels are the only part
// that must stay literally true, because they are the argument.
export function OmnivoreDemo({ palette }: { palette: VesselPalette }) {
  return (
    <div className="ah-demo-omnivore">
      {/* This demo is the FIXED-SIZE figure, so it owns its ⊔ inline. The other
          two omit `wall` and take their geometry from §1d, because they scale in
          `em` off a container query — see the two-mode note in primitives. */}
      <DemoVessel palette={palette} wall={8}>
        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Marguerite Oyelaran" time="5d" />
          <DemoTitle palette={palette}>Nobody is going to tell you this film is bad</DemoTitle>
          <DemoBody palette={palette}>
            Two hundred million dollars, four credited writers, and a marketing
            department that decided what you think of it in March. I watched it
            twice to be fair to it. It got worse&hellip;
          </DemoBody>
          <DemoTag palette={palette}>via RSS &middot; Nightshift &rarr;</DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Ines Bergqvist" time="6h" />
          <DemoBody palette={palette}>
            Four shells, one signature, and a seat on the board ninety days
            later. That is not a coincidence. That is a receipt.
          </DemoBody>
          <DemoQuote palette={palette} source="Quoting The Meridian">
            The department refused our request eleven times. The eleventh
            refusal was signed by the official who now sits on Halcyon&rsquo;s
            board.
          </DemoQuote>
          <DemoTag palette={palette}>
            via Bluesky &middot; bergqvist.all.haus &rarr;
          </DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Aurelio Frame" time="7h" />
          <DemoBody palette={palette}>
            Four in the morning at the fish market and a man has sold me a crate
            of something I cannot name for eleven euros. He drew me a picture of
            how to cook it. The picture is also unidentifiable.
          </DemoBody>
          <DemoTag palette={palette}>via Nostr &middot; aurelio@all.haus &rarr;</DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Ellis Marchetti" time="6d" paid />
          <DemoTitle palette={palette}>The men who bought the lights</DemoTitle>
          <DemoBody palette={palette}>
            Halcyon did not buy a power company. It bought the one thing a
            government cannot switch off without having to explain itself, and it
            did so in the week nobody was watching&hellip;
          </DemoBody>
          <DemoTag palette={palette}>via RSS &middot; Third Rail &rarr;</DemoTag>
        </DemoPost>
      </DemoVessel>
    </div>
  )
}
