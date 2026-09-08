// Explain engine — registry of kinds and the derived ordering.
//
// EXPLAIN-ADR §4 (ExplainKind), D4/D5/D7 (ordering + forks). This module is
// pure (no React, no DOM). Two programs consume it — first-run (editorialises)
// and Explain (describes) — sharing the kinds.
//
// ALL CAPTION PROSE LIVES IN ./copy.ts (one editable file, strings only;
// third-session amendment 2026-07-16). This module holds the machinery: the
// kind union, the flavour derivation, the resolvers, and the sequence orders.

import {
  CARD_FLAVOUR_COPY,
  EXPLAIN_LABELS,
  FIRST_RUN_COPY,
  VESSEL_COPY,
} from "./copy";

export { EXPLAIN_LABELS } from "./copy";

// ---------------------------------------------------------------------------
// Kinds (§4). Reserved `[next]` kinds (menu-open, per-surface pane interiors)
// ship no copy and no registration, so they are not in this union yet;
// `vessel.numeral`/`source.volume`/`card.pip` are cut or parked.
// ---------------------------------------------------------------------------

export type ExplainKind =
  // singletons
  | "floor"
  | "disc"
  // the nav-row muster — the run of numbered feed roundels (NAV-ROW-MUSTER-ADR
  // §VII). Hover-only, floor mode: the muster sits above the floor-mode scrim
  // (z-58 > 50), so — like the ∀ disc — it reports its own hover to the engine
  // rather than being found by the scrim's hit-test.
  | "navRow.muster"
  // the "About all.haus" button that stands in for the wordmark while a
  // program is active (D3, 2026-07-15 form). Hover-only: never in the
  // sequence, annotated via the button's own hover handlers.
  | "about"
  // the Glasshouse pane root — the base annotation of a PANE-mode Explain
  // program (D10 reversal, 2026-07-15 second session): when Explain opens
  // while a Glasshouse is up, the pane is the annotated surface and this kind
  // answers any hover its interior leaves don't. Tagged in Glasshouse.tsx, so
  // every pane inherits it; per-surface leaves arrive with the C-slices.
  | "pane"
  // C1 (2026-07-16) — universal pane chrome, tagged in Glasshouse.tsx: the
  // stretch handle (resizable panes), the feed-identity frame (feed-launched
  // panes), and the skip ears (feed-launched reader; the ear copy also teaches
  // the arrow keys). All hover-only: pane mode has no sequence by design.
  | "pane.resize"
  | "pane.frame"
  | "pane.ear.prev"
  | "pane.ear.next"
  // C1 — the reader interior: the reading surface (ReaderOverlay's scroll
  // body, answering hovers the gate doesn't) and the paywall gate
  // (PaywallGate, only present when a paywalled article is showing).
  | "reader"
  | "reader.gate"
  // The reader bar (2026-08-30) — the pane's thickened top. Its two leaves are
  // the card's two provenance affordances relocated, so their copy deliberately
  // echoes `card.originSource` / `card.originLink`: the same object must not
  // explain itself two different ways depending on which surface it is read off.
  | "reader.bar"
  | "reader.barSource"
  | "reader.barTitle"
  // C2 (2026-07-16) — writing surfaces, all hover-only (pane mode). Each
  // surface's base kind rides its pane body (the `reader` pattern: it answers
  // any hover its leaves don't): the note Composer, the article editor
  // (EditorOverlay/ArticleEditor; `editor.gate` is the in-document paywall
  // node, tagged in PaywallGateNode's node view), and the FeedComposer.
  | "composer"
  | "composer.crosspost"
  | "composer.article"
  | "editor"
  | "editor.dek"
  | "editor.paywall"
  | "editor.gate"
  | "editor.price"
  | "editor.tags"
  | "editor.schedule"
  | "editor.draft"
  | "editor.publication"
  | "feedComposer"
  | "feedComposer.addSource"
  | "feedComposer.source"
  | "feedComposer.volume"
  | "feedComposer.colour"
  | "feedComposer.view"
  | "feedComposer.orientation"
  | "feedComposer.textSize"
  | "feedComposer.order"
  | "feedComposer.hide"
  | "feedComposer.delete"
  // C3 (2026-07-16) — destination surfaces, all hover-only (pane mode). Each
  // overlay's base kind rides its scroll body (the `reader` pattern); the
  // generic `pane` copy keeps answering pane chrome. Messages (the merged
  // notifications + DMs inbox), the writer Dashboard, Library, Network,
  // Ledger (the money surface; copy Ed-approved), and Settings.
  | "messages"
  | "messages.notifications"
  | "messages.new"
  | "messages.thread"
  | "dashboard"
  | "dashboard.context"
  | "dashboard.articles"
  | "dashboard.gifts"
  | "dashboard.pricing"
  | "library"
  | "library.recent"
  | "library.holdings"
  | "network"
  | "network.dmFee"
  | "network.following"
  | "network.blocked"
  | "network.muted"
  | "ledger"
  | "ledger.balance"
  | "ledger.allowance"
  | "ledger.transactions"
  | "ledger.subscriptions"
  | "settings"
  | "settings.payment"
  | "settings.discovery"
  | "settings.reach"
  | "settings.theme"
  | "settings.typeSize"
  | "settings.export"
  // C4 (2026-07-16) — profile + surface overlays, all hover-only (pane mode).
  // `profile` rides ProfileOverlay's scroll body so the native and external
  // branches both inherit it; `source`/`tag`/`pub` ride SurfaceOverlay's
  // scroll body, switched on the target kind. Leaves live in the profile
  // action rows (WriterActivity, ProfileFollowControl, IdentityLinkControl,
  // AuthorProfileView's handle link) and the publication masthead
  // (PublicationPanel nav, PubFollowButton). The content logs inherit the
  // card.* kinds from the already-tagged chassis.
  | "profile"
  | "profile.follow"
  | "profile.followFeeds"
  | "profile.handle"
  | "profile.name"
  | "profile.subscribe"
  | "profile.identityLinks"
  // PROFILE-PANE-REDESIGN D7: the ALSO KNOWN AS row. Hover-only like its
  // siblings, so it joins no sequence array — the union member and the copy
  // entry are the whole wiring.
  | "profile.identityRow"
  // BYLINE-AND-PROVENANCE-ADR D6 (S4, 2026-08-29): the tier-C log header —
  // the source a byline-only author writes in, routing inward to /source/:id.
  | "profile.writingIn"
  | "source"
  | "tag"
  | "pub"
  | "pub.nav"
  | "pub.follow"
  // per-feed instance + tagged leaves
  | "vessel"
  | "vessel.name"
  | "vessel.gear"
  | "vessel.hide"
  | "vessel.addSource"
  | "vessel.resize"
  // card kinds — one representative instance in the sequence (D5), all
  // instances hover-discoverable
  | "card"
  | "card.byline"
  // BYLINE-AND-PROVENANCE-ADR D7 (2026-08-29): the provenance line is two
  // affordances — the source name (inward, to the source surface) and the
  // trailing arrow (the one route out to the original).
  | "card.originSource"
  | "card.originLink"
  // D8 (S2, 2026-08-29): the native card's counterpart — the publication an
  // article was published in, in the same slot, routing to /pub/:slug.
  | "card.originPublication"
  | "card.resonance"
  | "card.reply"
  | "card.quote";

// ---------------------------------------------------------------------------
// Card flavours (third-session amendment, 2026-07-16): the `card` label forks
// on what kind of item the card is. The flavour is derived here from the
// post's origin, carried on the card element as `data-explain-param`, and
// resolved back to copy by explainCardCopy. An unrecognised protocol yields
// null → the generic `card` fallback.
// ---------------------------------------------------------------------------

export type CardFlavour =
  | "native-article"
  | "native-note"
  | "nostr" // external Nostr (a native post is protocol "nostr" WITH a pubkey)
  | "atproto"
  | "activitypub"
  | "rss"
  | "email";

// Structural parameter (not the Post type) so this module stays dependency-free.
export function explainCardFlavour(post: {
  origin: { protocol: string };
  type: string;
  author: { pubkey: string | null };
}): CardFlavour | null {
  const p = post.origin.protocol;
  // Mirrors level-spec's isNativePost: native iff nostr + a custodial pubkey.
  if (p === "nostr" && post.author.pubkey) {
    return post.type === "article" ? "native-article" : "native-note";
  }
  if (
    p === "nostr" ||
    p === "atproto" ||
    p === "activitypub" ||
    p === "rss" ||
    p === "email"
  ) {
    return p;
  }
  return null;
}

// Copy for a card given its data-explain-param flavour (absent/unknown → the
// generic card label).
export function explainCardCopy(flavour: string | null | undefined): string {
  return (
    (flavour &&
      (CARD_FLAVOUR_COPY as Record<string, string | undefined>)[flavour]) ||
    EXPLAIN_LABELS.card
  );
}

// vessel label forks on provenance (D7): the Billy Island copy renders only on
// the actual starter clone; every other feed gets the neutral variant.
export function explainVesselLabel(fromStarter: boolean): string {
  return fromStarter ? VESSEL_COPY.starter : VESSEL_COPY.neutral;
}

// Resolve any Explain label, folding the vessel fork in. `fromStarter` is only
// consulted for `vessel`. (Card flavours are resolved by explainCardCopy — the
// caller has the param, this resolver has only the kind.)
export function explainCopy(kind: ExplainKind, fromStarter = false): string {
  return kind === "vessel"
    ? explainVesselLabel(fromStarter)
    : EXPLAIN_LABELS[kind];
}

// ---------------------------------------------------------------------------
// First-run program — Appendix A.1, six beats (prose in ./copy.ts).
//
// Beat 1 forks on provenance (D7); beat 6 carries the "done" affordance and two
// paragraphs. Beats 1-4 anchor to their kind where it exists, free-float centred
// where it does not (D8); beats 5-6 are floor beats and always free-float.
// ---------------------------------------------------------------------------

export interface FirstRunBeat {
  kind: ExplainKind;
  copy: string;
  // D8: beats 5-6 always free-float over the floor; beats 1-4 anchor if their
  // target exists and free-float centred otherwise (resolved at open()).
  alwaysFloat?: boolean;
  // Beat 6 carries the explicit dismiss affordance (§6).
  done?: boolean;
}

// The sequence, resolving the provenance fork for beat 1 and the arrival fork
// after the disc.
//
// `hasReading` ADDS A BEAT rather than changing one, and it is placed straight
// after the `disc` beat on purpose: it anchors on the disc too, so it lands
// while the reader is still looking at the menu it names. A step with nothing
// to offer is ABSENT rather than rendered empty — the same rule the deleted
// welcome sheet used, and the reason the count reads 6 or 7 rather than 7 with
// a hollow slot.
export function firstRunBeats(
  fromStarter: boolean,
  hasReading = false,
): FirstRunBeat[] {
  return [
    {
      kind: "vessel",
      copy: fromStarter
        ? FIRST_RUN_COPY.vesselStarter
        : FIRST_RUN_COPY.vesselNeutral,
    },
    { kind: "vessel.addSource", copy: FIRST_RUN_COPY.addSource },
    { kind: "card.byline", copy: FIRST_RUN_COPY.byline },
    { kind: "disc", copy: FIRST_RUN_COPY.disc },
    ...(hasReading
      ? [{ kind: "disc" as const, copy: FIRST_RUN_COPY.library }]
      : []),
    { kind: "floor", copy: FIRST_RUN_COPY.floor, alwaysFloat: true },
    {
      kind: "floor",
      copy: FIRST_RUN_COPY.finale,
      alwaysFloat: true,
      done: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Derived Explain ordering (§4, D4/D5).
//
//   floor → per-vessel (vessel, then its leaves) by sort_rank → card kinds
//   (one representative instance) → disc last.
//
// Pure over a minimal shape; the resolver (later slice) maps each step to a live
// DOM rect via the registration Map + `[data-explain]` query.
// ---------------------------------------------------------------------------

// The per-vessel leaf order — the vessel root first, then its tagged leaves.
export const VESSEL_LEAF_ORDER: readonly ExplainKind[] = [
  "vessel",
  "vessel.name",
  "vessel.gear",
  "vessel.hide",
  "vessel.addSource",
  "vessel.resize",
] as const;

// Card kinds contribute one representative sequential annotation each (D5).
export const CARD_KIND_ORDER: readonly ExplainKind[] = [
  "card",
  "card.byline",
  "card.resonance",
  "card.reply",
  "card.quote",
] as const;

export interface SequenceStep {
  kind: ExplainKind;
  // vessel + leaf steps carry the feedId they belong to; floor/disc/card kinds
  // (D5 representative) carry none.
  key?: string;
}

// Build the sequential Explain program from the vessels present at open().
// `vessels` are the registered vessel roots (feedId + sort_rank); `hasCards`
// gates the representative card kinds (D5: omitted, hover-only, if no vessel has
// cards).
export function buildExplainSequence(
  vessels: { key: string; order: number }[],
  hasCards: boolean,
): SequenceStep[] {
  const steps: SequenceStep[] = [{ kind: "floor" }];
  const sorted = [...vessels].sort((a, b) => a.order - b.order);
  for (const v of sorted) {
    for (const kind of VESSEL_LEAF_ORDER) steps.push({ kind, key: v.key });
  }
  if (hasCards) {
    for (const kind of CARD_KIND_ORDER) steps.push({ kind });
  }
  steps.push({ kind: "disc" });
  return steps;
}
