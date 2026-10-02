"use client";

// =============================================================================
// Profile chassis — the four tiers every profile surface is built from
// (PROFILE-PANE-REDESIGN-ADR D1). ONE body, three registers: the profile
// overlay, /[username], and /author/[authorId] all mount these, and the
// difference between the registers is passed in as a prop (the ✕'s `onClose`,
// the log below), never forked into a second implementation — the three
// hand-written headers this replaces are exactly what "bring them into line"
// produces (web/CLAUDE.md, "A surface that exists in both registers has ONE
// body and a seam").
//
//   Tier 1  palette.barBg    pfp · name · handle · + · actions · ✕
//   Tier 2  palette.interior  bio · stats · identity row · subscribe row
//   Tier 3  palette.interior  the view row (native: five counted buttons,
//                             `WriterActivity`; external: the tab rig)
//   Tier 4  palette.interior  post log, cards on palette.cardBg
//
// PALETTE (D2, AMENDED 2026-08-28): a profile OPENED FROM A FEED wears that
// feed's colourway ENTIRE — bar, interior, cards and the ⊓ frame — because the
// pane is that feed's card grown to full size, and inheriting only the side
// rules left a black bar sitting in a green frame. Everywhere else (the two
// standalone pages, a search result, any feed-agnostic launch) it keeps
// globalContentPalette(dark).
//
// The two branches DIFFER IN ISLANDING, and that difference is forced, not a
// style: globalContentPalette IS BASIC_LIGHT, whose slug references invert
// under html.dark, so islanding it would pin them canonical and the pane would
// stay light in dark mode. A scheme palette is the opposite — paletteFor()
// already picked the mode's light/dark VARIANT, whose surface slugs never
// invert, while the text tones it derives (bone / ink / white) are DARK_SLUGS
// that would invert on top of them. So a scheme palette must be islanded and
// the global one must not, exactly as a desktop vessel islands and the mobile
// feed does not. `profilePalette` + `profileIslandStyle` are the one home for
// that pairing — take them together or the pane renders text-on-text in dark
// mode.
//
// GEOMETRY: the bar's sizing and its desktop-pinned / mobile-in-flow behaviour
// live in globals.css §1e as media queries, not a useIsMobile branch — two of
// the three registers are SSR'd.
// =============================================================================

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { useLightbox } from "../../stores/lightbox";
import { useDiscCloseActive } from "../../stores/glasshouse";
import { InwardLink } from "../ui/InwardLink";
import { safeHttpUrl } from "../../lib/external-links";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";
import {
  globalContentPalette,
  paletteFor,
  VESSEL_GAP,
  VESSEL_PAD,
  VESSEL_WALL,
  type FeedScheme,
  type VesselPalette,
} from "../workspace/tokens";

/** The palette a profile surface renders in. `scheme` is the launching feed's
 *  colourway (useProfile's `frameScheme`) or null/undefined off a feed. */
export function profilePalette(
  scheme: FeedScheme | null | undefined,
  dark: boolean,
): VesselPalette {
  return scheme ? paletteFor(scheme, dark) : globalContentPalette(dark);
}

/** The island style that MUST accompany a scheme palette, and must NOT
 *  accompany the global one (see the PALETTE note above). */
export function profileIslandStyle(
  scheme: FeedScheme | null | undefined,
): CSSProperties | undefined {
  return scheme ? LIGHT_ISLAND_STYLE : undefined;
}

// ---------------------------------------------------------------------------
// Geometry — the profile IS a vessel, so it takes the vessel's own three
// numbers rather than an echo of them (§9.2, 2026-08-28; D5's 8px inset was
// the echo).
//
//   wall  8px   the ⊓ side rules, `VESSEL_WALL` — Glasshouse draws them as an
//               overlay in the pane's edge gutter, so the tiers must inset PAST
//               them or the wall lands on the cards;
//   pad  16px   `VESSEL_PAD`, wall → card, exactly as a vessel's scroll body;
//   gap  20px   `VESSEL_GAP` (12) on the log column PLUS each card's own
//               `GAP_PX.feed` (8) margin — the two are additive in a flex
//               column, which is what a feed actually renders.
// ---------------------------------------------------------------------------

/** Tier 2–4 inset: clear of the wall, then the vessel's interior padding. */
export const PROFILE_INSET = VESSEL_WALL + VESSEL_PAD;

/** THE PANE'S WIDTH, and the standalone pages' column with it (2026-09-02).
 *
 *  In the workspace a profile is a pane 860px wide; on `/username` and
 *  `/author/:id` the same body ran the full width of the browser, so the two
 *  registers of ONE surface had nothing in common dimensionally — a logged-out
 *  reader met a 1600px-wide bar and a line of cards nobody would choose to set
 *  text in. The standalone pages now centre the body at this width, so the two
 *  registers are the same shape and only the chrome around them differs.
 *
 *  ONE HOME, because it is one number in two places: `ProfileOverlay` passes it
 *  to `Glasshouse.maxWidth` and `ProfileSurface` takes it from the two bodies'
 *  register seams. A literal in either place is a drift waiting to happen. */
export const PROFILE_PANE_WIDTH = 860;

/** The card column of any log that means to read as a feed. Spread it; do not
 *  re-derive the number, and do not "simplify" it away — a bare wrapper leaves
 *  the log at the card margin alone (8px), which is HALF the rhythm of the feed
 *  beside it. Four surfaces shipped that way while their comments claimed the
 *  opposite (profile work/social, the external log, /tag, /source). */
export const FEED_LOG_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: VESSEL_GAP,
};

/** Protocol names as an identity chip says them — no "VIA" prefix (that belongs
 *  to a card's origin row, where the network is provenance rather than the
 *  identity itself). One home, so the chips and the link popover agree. */
const PROTOCOL_CHIP_LABELS: Record<string, string> = {
  rss: "RSS",
  atproto: "BLUESKY",
  activitypub: "FEDIVERSE",
  nostr_external: "NOSTR",
  nostr: "ALL.HAUS",
  email: "EMAIL",
};

export function protocolChipLabel(protocol: string): string {
  return PROTOCOL_CHIP_LABELS[protocol] ?? protocol.toUpperCase();
}

// -----------------------------------------------------------------------------
// Tier 1 — the bar
// -----------------------------------------------------------------------------

/** A profile picture sized by CSS (56 desktop / 40 mobile), with the house's
 *  initials fallback and the sitewide click-to-enlarge. Written here rather
 *  than reusing `<Avatar>` because that primitive takes a numeric size, which
 *  would put the form-factor branch back into JS on an SSR'd page. */
function ProfilePfp({
  src,
  name,
  palette,
}: {
  src?: string | null;
  name: string;
  palette: VesselPalette;
}) {
  const [failed, setFailed] = useState(false);
  const openLightbox = useLightbox((s) => s.open);

  if (!src || failed) {
    return (
      <span
        aria-hidden
        className="ah-profile-pfp inline-flex items-center justify-center rounded-full font-mono uppercase font-medium"
        style={{ background: palette.barInputBg, color: palette.barInputText }}
      >
        {(name || "?")[0].toUpperCase()}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openLightbox(src, name)}
      aria-label={`View ${name}'s picture`}
      className="ah-profile-pfp focus-ring cursor-zoom-in rounded-full overflow-hidden"
      style={{ background: palette.barInputBg }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </button>
  );
}

export interface ProfileBarProps {
  palette: VesselPalette;
  avatarUrl?: string | null;
  /** Display name — sans medium, never serif (D8: a screen name is chrome
   *  about a person, the same call D3 makes of the bio and D4 of the counts). */
  name: string;
  /** Rendered with its leading `@` already applied by the caller. */
  handle?: string | null;
  /** The handle's out-link to the origin platform; absent ⇒ plain text. */
  handleHref?: string | null;
  /** The NAME's out-link to this person's profile on their own network — set on
   *  external profiles only. It replaces the "VIA BLUESKY" strap the bar used to
   *  carry above the name: a reader who wants the origin network wants to GO
   *  there, and the strap named it without offering it while costing tier 1 a
   *  whole line. This is the one place the display name links OUT (web/CLAUDE.md
   *  › Profile surfaces: on a CARD the name goes to the all.haus profile and the
   *  handle is the out-link) — and it is not a conflict, because on this surface
   *  the all.haus profile is the page you are already standing on. */
  nameHref?: string | null;
  /** The `+` identity-link well — EXTERNAL profiles only (D7): an assertion
   *  needs two external_sources endpoints, so there is nothing a native `+`
   *  could ever store. */
  identityControl?: ReactNode;
  /** Message / Follow / Edit profile, or the logged-out `Log in` (D12). */
  actions?: ReactNode;
  /** The overlay register's alone (§5.1) — the standalone pages have nothing
   *  to close and simply don't pass it. */
  onClose?: () => void;
}

export function ProfileBar({
  palette,
  avatarUrl,
  name,
  handle,
  handleHref,
  nameHref,
  identityControl,
  actions,
  onClose,
}: ProfileBarProps) {
  const discClose = useDiscCloseActive();
  return (
    <div
      // `--drag` follows `onClose`, which is the overlay register's own seam
      // (§5.1): the standalone pages pass no close because they have nothing to
      // close, and they are also the ones with no pane to drag. The class
      // carries ONLY the cursor — the drag itself is `dragHandleSelector` on
      // the Glasshouse, so an unstyled bar could still be nominated; what must
      // never happen is a bar promising `grab` on a page where nothing moves.
      className={`ah-profile-bar${onClose ? " ah-profile-bar--drag" : ""}`}
      style={{ background: palette.barBg, color: palette.barText }}
    >
      <div className="ah-profile-bar-row">
        <ProfilePfp src={avatarUrl} name={name} palette={palette} />

        <div className="min-w-0 flex-1">
          <h1
            className="font-sans font-medium text-xl sm:text-2xl truncate"
            style={{ letterSpacing: "-0.02em", color: palette.barText }}
          >
            {/* `data-no-drag` for the same reason the handle carries it: an
                anchor already wins over the declared handle via NO_DRAG_SELECTOR,
                and the attribute keeps the two branches from silently differing.
                The <a> is INSIDE the h1 so the heading still reads as one. */}
            {nameHref ? (
              <a
                data-explain="profile.name"
                data-no-drag
                href={nameHref}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                style={{ color: "inherit" }}
              >
                {name}
              </a>
            ) : (
              name
            )}
          </h1>
          {(handle || identityControl) && (
            <div className="mt-0.5 flex items-center gap-2">
              {/* `data-no-drag` on the handle, and deliberately NOT on the name
                  above it. Tier 1 is the pane's declared drag handle (Q5), which
                  is what a bar is for and costs the display name its text
                  selection the way a window title bar does — no loss, since the
                  name is not an identifier anyone retypes. The handle IS one,
                  and it is the shortest element on the bar, so exempting it buys
                  back copy-and-paste for a few characters' worth of drag area.
                  The external branch is an `<a>` and already exempt via
                  NO_DRAG_SELECTOR; the attribute is on both so the two branches
                  do not silently differ. */}
              {handle &&
                (handleHref ? (
                  <a
                    data-explain="profile.handle"
                    data-no-drag
                    href={handleHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-mono-xs truncate hover:underline"
                    style={{ color: palette.barTextMuted }}
                  >
                    {handle}
                  </a>
                ) : (
                  <span
                    data-no-drag
                    className="text-mono-xs truncate"
                    style={{ color: palette.barTextMuted }}
                  >
                    {handle}
                  </span>
                ))}
              {identityControl}
            </div>
          )}
        </div>

        {actions && (
          <div className="ah-profile-controls flex items-center gap-2">
            {actions}
          </div>
        )}

        {/* The close lives HERE, not on the Glasshouse (D10). The shared ✕ is
            `text-grey-600 hover:text-black`, styled for the white pane it has
            always floated over: put a dark band under it and it is low-contrast
            at rest and hovers DARKER. Colouring it per-caller does not survive
            D9 either — with the bar scrolling away on mobile, a pinned ✕ tinted
            for the bar would float over the interior a moment later. A narrow,
            deliberate deviation from the canonical-close rule: what that rule
            protects (a floating ✕ at the top right, never a text "Close") is
            preserved exactly; what changes is which element parents it.

            It is the row's OWN child rather than a member of the control group,
            which is what keeps it on line 1 when D9's variant wraps the actions
            onto line 2 (Q2, judged on screen 2026-08-28): inside the group it
            rode the wrap and a full-screen sheet's close sat 60px below the top
            corner every reader looks in. The desktop order is unchanged — the
            ordering is in globals.css §1e, since the wrap is a media query.

            On the mobile workspace it withdraws entirely: the ∀ disc has
            already flipped to this sheet's X, and the pane needs exactly one.
            The gate is the disc's own DECLARATION, never `isMobile` — this
            pane opens from /article/:dTag and the public register too, where
            no disc is mounted (stores/glasshouse.ts::useDiscCloseActive). The
            page registers pass no `onClose` at all and are untouched. */}
        {onClose && !discClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ah-profile-close focus-ring text-lg leading-none transition-opacity hover:opacity-70"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: palette.barText,
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Bar controls — the bar is not a white pane, so `.btn*` cannot be used on it
// -----------------------------------------------------------------------------

/** A button on tier 1. `.btn` is ink-on-ink against `barBg`, so bar controls
 *  take the palette's own bar tokens: primary is the photo-negative (barText
 *  fill, barBg glyph), secondary the well fill. Both invert coherently with the
 *  bar itself, which is the point of driving them off the palette. */
export function BarButton({
  variant = "secondary",
  palette,
  className = "",
  style,
  href,
  ...rest
}: {
  variant?: "primary" | "secondary";
  palette: VesselPalette;
  /** Renders a real `<Link>` wearing the bar tone instead of a `<button>`.
   *  A bar control that NAVIGATES is still a bar control — the logged-out
   *  "Log in to follow" offer took `.btn`, which is ink on ink against
   *  `barBg` and so invisible in dark mode, which is the whole reason the
   *  tone lives here and not at the call sites. */
  href?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const tone: CSSProperties =
    variant === "primary"
      ? { background: palette.barText, color: palette.barBg }
      : { background: palette.barInputBg, color: palette.barInputText };
  const cls = `focus-ring font-sans text-ui-xs font-medium transition-opacity hover:opacity-85 disabled:opacity-50 ${className}`;
  const css: CSSProperties = {
    border: "none",
    borderRadius: 0,
    padding: "0.375rem 0.875rem",
    cursor: "pointer",
    ...tone,
    ...style,
  };
  if (href) {
    return (
      <Link href={href} className={`inline-block ${cls}`} style={css}>
        {rest.children}
      </Link>
    );
  }
  return <button {...rest} className={cls} style={css} />;
}

// -----------------------------------------------------------------------------
// Tier 2 — bio, stats, identity row, subscribe row
// -----------------------------------------------------------------------------

/** One entry in the profile's "also known as" row (D7). The three tiers must
 *  render distinguishably — a verified presence and one reader's hunch making
 *  the same visual claim is the whole failure this consolidates away — so each
 *  chip states its tier in words rather than by a weight the reader has to
 *  learn. */
export interface ProfileIdentity {
  key: string;
  /** verified: the SUBJECT proved it (network_presences, any provenance).
   *  detected: the PLATFORM inferred it (a global external_identity_link).
   *  asserted: the VIEWER said so (their own user_asserted link). */
  tier: "verified" | "detected" | "asserted";
  /** Protocol label — BLUESKY / FEDIVERSE / NOSTR / RSS. */
  protocol: string;
  /** Display name or handle for the identity over there. */
  label: string;
  href?: string;
}

const TIER_WORD: Record<ProfileIdentity["tier"], string> = {
  verified: "VERIFIED",
  detected: "DETECTED",
  asserted: "YOU LINKED",
};

export function ProfileIdentityRow({
  palette,
  identities,
}: {
  palette: VesselPalette;
  identities: ProfileIdentity[];
}) {
  if (identities.length === 0) return null;
  return (
    <div
      data-explain="profile.identityRow"
      className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1"
    >
      {/* cardStandfirst, not cardMeta: stone-400 on the bone interior is
          3.09:1 — measured, not guessed — and these are FACTS about a person
          rather than hints. The header this replaces had already been corrected
          the same way once (grey-300 → grey-600, with the reason in a comment
          on the SSR page); re-deriving it from the card ramp would have quietly
          undone that. */}
      <span className="label-ui" style={{ color: palette.cardStandfirst }}>
        ALSO KNOWN AS
      </span>
      {identities.map((id) => {
        const body = (
          <>
            <span style={{ color: palette.cardTitle }}>{id.label}</span>{" "}
            <span className="label-ui" style={{ color: palette.cardStandfirst }}>
              {id.protocol} · {TIER_WORD[id.tier]}
            </span>
          </>
        );
        // Every href that leaves all.haus goes through `safeHttpUrl` (CA-E15);
        // one it refuses renders as the plain label.
        const href = safeHttpUrl(id.href);
        return href ? (
          <a
            key={id.key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ui-xs hover:underline"
          >
            {body}
          </a>
        ) : (
          <span key={id.key} className="text-ui-xs">
            {body}
          </span>
        );
      })}
    </div>
  );
}

/** The tier-C log header (BYLINE-AND-PROVENANCE-ADR D6): the source a
 *  byline-only author writes in. Same grammar as the identity row beneath it —
 *  a `label-ui` word, then the fact — and the source name routes INWARD through
 *  `InwardLink` exactly as the card's provenance line does (D7), so "you follow
 *  sources" holds on the profile too: the name opens `/source/:id` in the
 *  overlay, and the Follow control on the bar is already that source's. No
 *  bio, no website, no out-link: there is no origin profile to point at, and
 *  a line that named one without offering it is the strap §9 retired.
 *
 *  Wording (Q3): "WRITING IN" states where these posts appeared, not that the
 *  person writes nowhere else — a widened log would add sources to this line,
 *  not contradict it. */
export function ProfileWritingIn({
  palette,
  sources,
}: {
  palette: VesselPalette;
  /** One per backing source; `href` absent when the source row is gone (the
   *  gateway's base response carries a name only). */
  sources: { key: string; name: string; protocol: string; href?: string }[];
}) {
  if (sources.length === 0) return null;
  return (
    <div
      data-explain="profile.writingIn"
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1"
    >
      <span className="label-ui" style={{ color: palette.cardStandfirst }}>
        WRITING IN
      </span>
      {sources.map((src) => {
        const body = (
          <>
            <span style={{ color: palette.cardTitle }}>{src.name}</span>{" "}
            <span className="label-ui" style={{ color: palette.cardStandfirst }}>
              {src.protocol}
            </span>
          </>
        );
        return src.href ? (
          <InwardLink
            key={src.key}
            href={src.href}
            explain="profile.writingIn"
            className="text-ui-sm hover:underline"
          >
            {body}
          </InwardLink>
        ) : (
          <span key={src.key} className="text-ui-sm">
            {body}
          </span>
        );
      })}
    </div>
  );
}

export function ProfileMeta({
  palette,
  writingIn,
  bio,
  stats,
  identities,
  subscribeRow,
  children,
}: {
  palette: VesselPalette;
  /** The tier-C log header (BYLINE-AND-PROVENANCE-ADR D6, S4): "WRITING IN
   *  The Guardian" — the source a byline-only author writes in, in the slot
   *  the bio would take, because a journalist's context IS the paper. Leads
   *  tier 2 so it reads as the header D6 asks for and not as an afterthought
   *  beneath counts the author will never have. The caller composes it
   *  (`ProfileWritingIn`) so a widened log (Q3) can list several sources on
   *  the same line without this chassis changing. */
  writingIn?: ReactNode;
  bio?: string | null;
  /** The counts line — mono (D4), ending with RSS where there is one (D12).
   *  The NATIVE body passes none: its five counts are the labels of tier 3's
   *  button row, which is the same navigation and would otherwise be stated
   *  twice, and RSS rode along to the end of that row. `AuthorProfileView`
   *  still uses this slot. */
  stats?: ReactNode;
  identities?: ProfileIdentity[];
  /** The profile's one money affordance gets settled ground, never the bar
   *  (D12): two buttons plus an error line is too much furniture for a chrome
   *  band. */
  subscribeRow?: ReactNode;
  /** Anything else that belongs on tier 2 (the parked trust block). */
  children?: ReactNode;
}) {
  return (
    <div className="pb-6 pt-6">
      {writingIn}
      {bio && (
        // Sans, not serif (D3): Literata is the literary voice — the writer's
        // prose. A bio is chrome about a person.
        <p
          className="text-ui-sm leading-relaxed"
          style={{ color: palette.cardStandfirst, maxWidth: "62ch" }}
        >
          {bio}
        </p>
      )}
      {stats && (
        // Same correction as the identity row above: the counts are facts, and
        // stone-400 on the interior measures 3.09:1 in light mode.
        <p
          className={`text-mono-xs ${bio ? "mt-3" : ""}`}
          style={{ color: palette.cardStandfirst }}
        >
          {stats}
        </p>
      )}
      {identities && (
        <ProfileIdentityRow palette={palette} identities={identities} />
      )}
      {subscribeRow && <div className="mt-4">{subscribeRow}</div>}
      {children}
    </div>
  );
}

// -----------------------------------------------------------------------------
// The surface
// -----------------------------------------------------------------------------

export function ProfileSurface({
  palette,
  scheme,
  bar,
  children,
  minHeight,
  maxWidth,
}: {
  palette: VesselPalette;
  /** The launching feed's colourway, if any — carried here ONLY to apply the
   *  island that a scheme palette requires and the global one forbids (see the
   *  PALETTE note at the top). Pass the same value `profilePalette` was given. */
  scheme?: FeedScheme | null;
  bar: ReactNode;
  children: ReactNode;
  /** The standalone pages own their height; the overlay body does not. */
  minHeight?: string;
  /** `PROFILE_PANE_WIDTH` on the STANDALONE pages, which have no pane to size
   *  them, and undefined in the overlay, where the Glasshouse already is that
   *  width. Set ⇒ the whole body (tier 1 included) centres at this width on the
   *  interior, so the page reads as the pane it is in the workspace. */
  maxWidth?: number;
}) {
  // Tier 1 is FULL-BLEED, so the horizontal padding lives on the tiers rather
  // than on the scroller — a pad here would inset the bar and leave a stripe of
  // pane down each side of it (D9).
  const body = (
    <>
      {bar}
      <div style={{ padding: PROFILE_INSET, flex: "1 0 auto" }}>{children}</div>
    </>
  );

  return (
    <div
      data-explain="profile"
      style={{
        ...profileIslandStyle(scheme),
        background: palette.interior,
        minHeight,
        // Column + a growing body so the interior (and the ⊓ walls drawn over
        // its edges) runs to the foot of a pane that now reaches the window
        // bottom, instead of stopping where the log happens to end.
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* The centring wrapper exists ONLY on the standalone pages. The overlay
          renders the same DOM it always has — a shared body is where a public
          page silently redesigns the member surface (PublicPage's own note), so
          the register that did not ask for this gets no new box in its tree.
          The interior is painted by the element ABOVE this one, full-bleed, so
          the gutters either side are the profile's own ground and never fall
          through to `body` (white in light, ink-900 in dark). */}
      {maxWidth ? (
        <div
          style={{
            position: "relative",
            width: "100%",
            maxWidth,
            marginInline: "auto",
            flex: "1 0 auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* THE ⊓, on the standalone pages (2026-09-02). In the workspace the
              Glasshouse draws the frame in the pane's edge gutter; here nothing
              was drawing it, so the column read as a centred body rather than as
              the vessel the overlay register is. Same construction as
              `Glasshouse`'s: a pointer-events-none colour overlay in the gutter
              the tiers already inset past (`PROFILE_INSET` = wall + pad), so it
              costs the content no width and disturbs no scroll geometry.
              `frameTopSlot`'s twin holds here too — tier 1 IS the top stroke, so
              there is no top rule to draw; and the ⊓ is OPEN AT THE BOTTOM, which
              it is by construction, the column running to the foot of the page.
              Both rules take `palette.walls`, the same object tier 1's `barBg`
              comes off, so the bar reads as the frame's thick top rather than a
              slab sitting inside a frame of some other colour (D2 as amended).
              Desktop only, in CSS not a `useIsMobile` branch — these two
              registers are SSR'd, and the mobile pane has no frame either. */}
          <div
            aria-hidden
            className="ah-profile-wall pointer-events-none absolute bottom-0 left-0 top-0"
            style={{ width: VESSEL_WALL, background: palette.walls }}
          />
          <div
            aria-hidden
            className="ah-profile-wall pointer-events-none absolute bottom-0 right-0 top-0"
            style={{ width: VESSEL_WALL, background: palette.walls }}
          />
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  );
}
