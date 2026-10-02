"use client";

import React from "react";
import type { Post } from "../../lib/post/types";
import { originWebUrl } from "../../lib/post/origin-url";
import { InwardLink } from "../ui/InwardLink";
import { PlatformResonance } from "./PostResonance";
import { formatDateRelative } from "../../lib/format";
import type { VesselPalette } from "../workspace/tokens";
import { sourcePageId } from "../../lib/post/source-page";

// =============================================================================
// PostOriginTag — the provenance line (§4 matrix row): `VIA RSS · The Guardian →`
//
// Two identities, two slots (BYLINE-AND-PROVENANCE-ADR D1): the byline names
// who wrote this post; this line names THE THING YOU SUBSCRIBED TO. D7 splits
// it into two affordances that used to be one button:
//
//   • the SOURCE NAME is an internal link to the all.haus source surface
//     (`/source/:id`) — `InwardLink` (components/ui): a real <Link>, so
//     new-tab / copy-link work, with a plain left-click intercepted by
//     `openSurfaceHref` so inside the workspace it re-roots the surface
//     overlay in place rather than escaping (`.claude/rules/web-overlays.md`
//     › The escape ban);
//   • the trailing `→` is the SINGLE route out to the content's original
//     location (CARD-BEHAVIOUR-ADR §VI.4). Nothing else on a card leaves
//     all.haus.
//
// Tier D degrades to source-name only (no handle/identifier) — and the source
// link stays in that arm too, since tier D is every RSS card (ADR D5 ⟂).
// A GENUINE tier-D post — no author name at all, ever — has no byline row
// (ADR D9 + Q1, S5): the title leads, and this line takes the TIMESTAMP
// (`showTime`) and the card's drag handle (`dragHandle`), since it is then the
// only row that names the source the gesture moves.
// Native content is labelled ALL.HAUS and carries no outbound link (all.haus
// IS the origin). A native article published IN a publication puts the
// publication in the same slot (ADR D8, S2): `VIA ALL.HAUS · The Recurse`,
// the name a `/pub/:slug` link with the same overlay intercept — the
// publication is the thing the reader subscribed to, where that is not the
// writer. Without it the native card is the only card that hides its
// container, and the two-slot grammar is not universal.
// =============================================================================

const PROTOCOL_DISPLAY: Record<string, string> = {
  rss: "RSS",
  atproto: "BLUESKY",
  activitypub: "FEDIVERSE",
  nostr_external: "NOSTR",
  email: "EMAIL",
};

export function PostOriginTag({
  post,
  palette,
  sourceOnly,
  showPlatformMark,
  showTime,
  dragHandle,
}: {
  post: Post;
  palette: VesselPalette;
  sourceOnly: boolean; // tier D
  // Q1: the card has no byline row, so the timestamp lives here — after the
  // source name, before the `→`.
  showTime?: boolean;
  // Q1: with no byline the provenance line is the card's grab handle
  // (chassis.tsx::CARD_DRAG_HANDLE_SELECTOR); links inside it still win.
  dragHandle?: boolean;
  // D7 platform-scope resonance mark. It sits immediately after the network
  // name because ADJACENCY IS WHAT GIVES IT ITS SCOPE — the same triangle in
  // the byline means "popping for this author", here it means "popping for
  // this network". Moving it away from the name would strand the claim.
  showPlatformMark?: boolean;
}) {
  const isNative = post.origin.protocol === "nostr" && !!post.author.pubkey;
  const mark = showPlatformMark ? (
    <>
      {" "}
      <PlatformResonance post={post} palette={palette} />
    </>
  ) : null;

  // Slice 8 P1: "ALSO ON …" — the other linked sources cross-posting this content.
  const alsoOnLabels = (post.alsoOn ?? [])
    .map((p) => PROTOCOL_DISPLAY[p] ?? p.toUpperCase())
    .filter((v, i, a) => a.indexOf(v) === i);
  const alsoOn =
    alsoOnLabels.length > 0 ? (
      <TagText palette={palette}>ALSO ON {alsoOnLabels.join(" · ")}</TagText>
    ) : null;

  if (isNative) {
    const publication = post.origin.publication ?? null;
    return (
      <>
        <TagText palette={palette}>
          VIA ALL.HAUS
          {mark}
          {publication ? (
            <>
              {" · "}
              {/* An archived/suspended publication no longer resolves at
                  /pub/:slug (the route 404s unless status = 'active'), but
                  "published in X" is still true — so the name stays and only
                  the link goes. */}
              {publication.active ? (
                <InwardLink
                  href={`/pub/${encodeURIComponent(publication.slug)}`}
                  explain="card.originPublication"
                  frameScheme={palette.scheme}
                >
                  {publication.name}
                </InwardLink>
              ) : (
                publication.name
              )}
            </>
          ) : null}
        </TagText>
        {alsoOn}
      </>
    );
  }

  const label = PROTOCOL_DISPLAY[post.origin.protocol] ?? post.origin.protocol.toUpperCase();
  const community = post.origin.sourceName ?? undefined;
  const identifier = sourceOnly ? undefined : post.author.handle ?? undefined;
  // The source surface exists only for a real source row; a context-only
  // (hydrated) row has its sourceName nulled by the mapper, so `community` is
  // already absent there and no link is offered for a source that isn't this
  // post's.
  const sourceId = sourcePageId(post);
  const sourceHref =
    community && sourceId ? `/source/${encodeURIComponent(sourceId)}` : undefined;
  const originHref = originWebUrl(post);
  const time = showTime ? (
    <>
      {" · "}
      <time dateTime={new Date(post.publishedAt * 1000).toISOString()}>
        {formatDateRelative(post.publishedAt)}
      </time>
    </>
  ) : null;

  return (
    <>
      <TagText palette={palette} dragHandle={dragHandle}>
        VIA {label}
        {mark}
        {community ? (
          <>
            {" · "}
            {sourceHref ? (
              <InwardLink
                href={sourceHref}
                explain="card.originSource"
                frameScheme={palette.scheme}
              >
                {community}
              </InwardLink>
            ) : (
              community
            )}
          </>
        ) : null}
        {identifier ? ` · ${identifier}` : ""}
        {time}
        {originHref ? (
          <>
            {" "}
            <a
              href={originHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="hover:opacity-80"
              style={{ color: "inherit" }}
              aria-label="Open the original"
              title="Open the original"
              data-explain="card.originLink"
            >
              →
            </a>
          </>
        ) : null}
      </TagText>
      {alsoOn}
    </>
  );
}

function TagText({
  palette,
  children,
  dragHandle,
}: {
  palette: VesselPalette;
  children: React.ReactNode;
  dragHandle?: boolean;
}) {
  return (
    <div
      className="font-mono text-[0.625rem] uppercase tracking-[0.06em] mt-2"
      // A handle has no break opportunity of its own, so a long one would
      // run past the card's edge; `anywhere` lets it break there instead.
      style={{
        color: palette.cardMeta,
        cursor: dragHandle ? "grab" : undefined,
        overflowWrap: "anywhere",
      }}
      data-card-drag-handle={dragHandle ? "" : undefined}
    >
      {children}
    </div>
  );
}
