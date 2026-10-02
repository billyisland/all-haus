"use client";

// =============================================================================
// ReaderOverlay — UNIVERSAL-POST-ADR §3.1 / Phase R
//
// The single reading environment over the workspace. Driven by the useReader
// store; mounted once in WorkspaceView. Renders, by target kind:
//   - native   → ArticleReader (gate-pass unlock + decrypt, client-fetched by dTag)
//   - external → ExternalArticleReader (GET /extract reader-mode body)
// backed by a real URL (the store pushes /article/<dTag> or /read/<postId>), so
// Back / Esc / scrim all close and restore the prior URL. Direct visits to those
// URLs render the same inner readers full-page (article/[dTag], reader/[postId]).
//
// Replaces the old ephemeral ReaderPane (deleted). Separation is whitespace +
// the existing slab rules inside the readers, per the sitewide no-thin-line rule.
//
// THE READER BAR (2026-08-30). The pane's top is no longer the ⊓'s 8px stroke
// but a thickened bar carrying the pane's two identities, the same split the
// card makes (BYLINE-AND-PROVENANCE-ADR D1/D7) and the same shape the profile
// pane's tier 1 took (PROFILE-PANE-REDESIGN-ADR W3/D10):
//
//   • LEFT — the SOURCE, routing INWARD. External: the source surface
//     (`/source/:id`, via `InwardLink` so the workspace re-roots in place
//     rather than escaping). Native: the publication if the article is in one
//     (`/pub/:slug`), else the writer (`/<username>`, via `ProfileLink`).
//   • RIGHT — the TITLE, routing OUTWARD in a new tab, and the pane's ✕.
//     External: the origin URL. Native: `/article/<dTag>` — the addressable
//     public page, which is what a logged-out reader sees. New tab, not this
//     one: a same-tab navigation there would leave the workspace, which is the
//     escape ban (web/CLAUDE.md).
//
// The title is capped at HALF the bar so the source can never be crowded out
// of its own end, and truncates with an ellipsis inside that.
//
// Three Glasshouse props follow from the bar rather than being decoration:
// `frameTopSlot` (the bar IS the ⊓'s top, so the frame must not stroke a second
// thinner one over it), `hideClose` (the shared ✕ is grey-on-white and would sit
// low-contrast on the band, hovering DARKER — the bar renders its own in the
// frame's own text tone), and `dragHandleSelector` (the grip pill would be a
// fleck floating on the band; a bar is what a window is dragged by). `topSeam`
// went with them: it existed to give prose somewhere to dissolve as it scrolled
// under the pinned grip, and nothing scrolls under an in-flow bar.
// =============================================================================

import React, { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useReader } from "../../stores/reader";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Glasshouse } from "./Glasshouse";
import { ExternalArticleReader } from "../article/ExternalArticleReader";
import { ArticleReader } from "../article/ArticleReader";
import { articles, type ArticleMetadata } from "../../lib/api";
import { InwardLink } from "../ui/InwardLink";
import { safeHttpUrl } from "../../lib/external-links";
import { ProfileLink } from "../ui/ProfileLink";
import { profilePalette } from "../profile/ProfileChrome";
import { useResolvedDark } from "../../stores/colorScheme";
import { useDiscCloseActive } from "../../stores/glasshouse";
import { PANE_BAR_H, type FeedScheme, type VesselPalette } from "./tokens";

export function ReaderOverlay() {
  const {
    isOpen,
    target,
    close,
    dismiss,
    _handlePop,
    frameScheme,
    nav,
    skip,
  } = useReader();

  // ONE palette for the whole pane — the bar, the ⊓ and the ear arrows all come
  // off it, so they cannot pair wrongly. Feed-launched it is that feed's
  // colourway; elsewhere the global content palette, whose walls are ink, so a
  // reader opened from the library or a search draws the house's ⊓ rather than
  // a bar with no shape under it. Passing three colour strings instead was the
  // bug this replaced: the bar's own fallback was ink-925 (never inverted)
  // over bone (inverted), which is dark-on-dark in dark mode. `barBg`/`barText`
  // are the sanctioned pair (globalContentPalette's header), and for a scheme
  // palette `barBg` IS `walls`, so bar and rules stay one vessel.
  const dark = useResolvedDark();
  const palette = profilePalette(frameScheme, dark);

  // Glasshouse owns the chrome, Escape, and scroll-lock. The reader keeps only
  // the URL-sync concern: browser Back pops our pushed /article·/reader entry,
  // so _handlePop must run on popstate to finalise close. Gated on isOpen.
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("popstate", _handlePop);
    return () => window.removeEventListener("popstate", _handlePop);
  }, [isOpen, _handlePop]);

  // Arrow-key reading controls. Up / down scroll the reading pane (the natural
  // gesture as you read down a piece); left / right flip back / forward through
  // the parent feed's articles — the keyboard twin of the skip ears, so you tap
  // → to start the next one. Scroll works whenever the reader is open; skip only
  // while launched from a feed (hasNav). `skip` reads the live nav from the
  // store and no-ops at the ends. Ignore the keys when a field has focus (caret
  // movement) or a modifier is held (browser shortcuts like Alt+←/⌘←).
  //
  // Instant (not smooth) scrollBy so key auto-repeat — holding ↓ — reads as one
  // continuous scroll rather than a stutter of queued animations.
  const SCROLL_STEP = 80;
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasNav = !!nav;
  const isMobile = useIsMobile();

  // Horizontal swipe — the touch twin of the ←/→ skip keys (and the desktop
  // skip ears). On mobile, a decisive horizontal swipe across the reading pane
  // flips to the previous / next article in the parent feed; only meaningful
  // when launched from a feed (hasNav). Swipe left → next (the → key); swipe
  // right → previous (the ← key) — the standard paged-content convention.
  // Vertical-dominant gestures fall through to normal scrolling, and a swipe
  // that begins inside a horizontally-scrollable element (wide code block or
  // image) is left to that element — mirroring the mobile pager's restraint.
  // The native article, fetched HERE rather than inside NativeArticleBody: the
  // bar needs the publication / writer to name the source, and it is pinned
  // outside the scroll body, so the body cannot be the thing that resolves it.
  // Keyed on the d-tag; external targets clear it.
  const nativeDTag = isOpen && target?.kind === "native" ? target.dTag : null;
  const [article, setArticle] = useState<ArticleMetadata | null>(null);
  const [articleError, setArticleError] = useState(false);
  useEffect(() => {
    if (!nativeDTag) {
      setArticle(null);
      setArticleError(false);
      return;
    }
    let cancelled = false;
    setArticle(null);
    setArticleError(false);
    articles
      .getByDTag(nativeDTag)
      .then((a) => {
        if (!cancelled) setArticle(a);
      })
      .catch(() => {
        if (!cancelled) setArticleError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nativeDTag]);

  // A SKIP IS A NEW PIECE IN THE SAME ELEMENT, so the pane's scroller has to be
  // told. The ears, ←/→ and the mobile swipe all change `target` in place —
  // the Glasshouse, the scroll div and the reader body component all survive —
  // so without this the next article opened at whatever offset the last one was
  // left at. Its twin is in `useReadingPosition`, which resets its own
  // per-piece refs on the same change; between them a skip starts at the top
  // and the restore then moves it, exactly as opening the piece cold does.
  //
  // A LAYOUT effect, and the ORDER is the point: React runs child passive
  // effects before parent ones, so a passive reset here would fire AFTER the
  // reader body's `useReadingPosition` had already read the stale scrollTop.
  // Layout effects all run before any passive effect, so this lands first.
  const targetKey =
    target === null
      ? null
      : target.kind === "native"
        ? `native:${target.dTag}`
        : `external:${target.url}`;
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [targetKey]);

  const SWIPE_MIN_X = 56;
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const hasScrollableXAncestor = (
    start: Element | null,
    root: Element,
  ): boolean => {
    let el: Element | null = start;
    while (el && el !== root) {
      if (el.scrollWidth > el.clientWidth) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      el = el.parentElement;
    }
    return false;
  };
  const onSwipeStart = (e: React.TouchEvent) => {
    if (!hasNav || !isMobile || e.touches.length !== 1) {
      swipeRef.current = null;
      return;
    }
    if (hasScrollableXAncestor(e.target as Element, e.currentTarget)) {
      swipeRef.current = null;
      return;
    }
    const t = e.touches[0];
    swipeRef.current = { x: t.clientX, y: t.clientY };
  };
  const onSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || !hasNav || !isMobile) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Decisive horizontal: enough travel, and clearly more across than down.
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) <= Math.abs(dy)) return;
    skip(dx < 0 ? 1 : -1);
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollRef.current?.scrollBy(0, SCROLL_STEP);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollRef.current?.scrollBy(0, -SCROLL_STEP);
      } else if (hasNav && e.key === "ArrowLeft") {
        e.preventDefault();
        skip(-1);
      } else if (hasNav && e.key === "ArrowRight") {
        e.preventDefault();
        skip(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, hasNav, skip]);

  if (!isOpen || !target) return null;

  const isNative = target.kind === "native";
  // Wider panes in the overlay than the full-page routes so the text column
  // keeps its reading measure while the side whitespace roughly doubles
  // (native ~90px → ~180px; external 48px → 96px each side).
  const maxWidth = isNative ? 1000 : 736;

  // Feed-skip ears: present only when launched from a feed (nav set). Up the
  // feed = previous article, down = next.
  const sideNav = nav
    ? {
        onPrev: () => skip(-1),
        onNext: () => skip(1),
        canPrev: nav.index > 0,
        canNext: nav.index < nav.entries.length - 1,
      }
    : null;

  // What the bar names, per target kind. The source routes INWARD, the title
  // OUTWARD — the card's two affordances, relocated (BYLINE-AND-PROVENANCE D7).
  const bar =
    target.kind === "external"
      ? {
          sourceName: target.siteName,
          // Only a real source row has a surface. A cold /read/:postId reload
          // (and a context-only row, whose sourceName the mapper has already
          // nulled) leaves this null and the name renders as plain text.
          sourceHref: target.sourceId
            ? `/source/${encodeURIComponent(target.sourceId)}`
            : null,
          sourceKind: "surface" as const,
          title: target.title,
          // The origin URL is ingested data; the native branch below builds an
          // internal path and needs no gate.
          titleHref: safeHttpUrl(target.url) ?? null,
        }
      : {
          // Publication else writer: the publication is the thing subscribed to
          // where that isn't the writer, and outside one the writer IS it.
          // Both come off the fetched article, so the slot fills on load —
          // the seeded `preview` covers the title in the meantime.
          sourceName: article?.publication?.name ?? article?.writer.displayName ?? article?.writer.username ?? null,
          sourceHref: article?.publication
            ? `/pub/${encodeURIComponent(article.publication.slug)}`
            : article
              ? `/${encodeURIComponent(article.writer.username)}`
              : null,
          sourceKind: article?.publication
            ? ("surface" as const)
            : ("profile" as const),
          title: target.preview?.title ?? article?.title ?? null,
          titleHref: `/article/${encodeURIComponent(target.dTag)}`,
        };

  return (
    <Glasshouse
      onClose={close}
      onSupersede={dismiss}
      selfHistory
      maxWidth={maxWidth}
      ariaLabel="Reader"
      persistKey="reader"
      resizable
      fillHeight
      coverNavChrome
      frameColor={palette.walls}
      frameTextColor={palette.barText}
      // The bar IS the ⊓'s thick top (see the header): no second stroke over
      // it, no grey ✕ on the band, no grip pill floating in it.
      frameTopSlot
      hideClose
      dragHandleSelector=".ah-pane-bar"
      sideNav={sideNav}
    >
      <ReaderBar {...bar} onClose={close} palette={palette} frameScheme={frameScheme} />
      <div
        ref={scrollRef}
        onTouchStart={onSwipeStart}
        onTouchEnd={onSwipeEnd}
        // Explain C1: the reading surface's own label — answers any interior
        // hover a more specific leaf (reader.gate) doesn't, ahead of the
        // generic `pane` tag on the Glasshouse root.
        data-explain="reader"
        // A reading surface keeps its scroll marker; every other scroller in
        // the product is silent by default (globals.css). The overlay and the
        // standalone /article page are the same piece read two ways, so they
        // must agree — see ReadingScrollbar, which does this for that page.
        className="overflow-y-auto ah-scrollbar"
        // The bar is in flow above this, so the body's share of the pane is
        // what the bar leaves. Inline rather than an arbitrary Tailwind calc so
        // the one constant stays the only place the height is written.
        style={{ maxHeight: `calc(var(--gh-h) - ${PANE_BAR_H}px)` }}
      >
        {target.kind === "external" ? (
          <ExternalArticleReader
            url={target.url}
            // Inside a Glasshouse the DOCUMENT does not scroll — this div does.
            // Handing the resume hook the pane's own scroller is the whole of
            // D9's repair; without it the hook measures a document that never
            // moves and saves a ratio of 0 forever, which reads as an entirely
            // ordinary position and so said nothing for its whole life.
            scrollRef={scrollRef}
            postId={target.postId ?? null}
            title={target.title}
            siteName={target.siteName}
            // The item's own enclosure video, which the card plays and the pane
            // did not — the /extract body is the ORIGIN PAGE, and an RSS item's
            // video is often carried by the item alone.
            media={target.media}
            paddingX="px-6 sm:px-12 md:px-24"
            // The site name has moved to the bar; leaving it in the header too
            // would print the same identity twice, three lines apart.
            showSiteName={false}
          />
        ) : (
          <NativeArticleBody
            article={article}
            error={articleError}
            preview={target.preview}
            focusCommentId={target.focusCommentId ?? null}
            scrollRef={scrollRef}
          />
        )}
      </div>
    </Glasshouse>
  );
}

// -----------------------------------------------------------------------------
// ReaderBar — the pane's thickened top: source at the left end, title at the
// right, ✕ beyond it. Painted from the pane's ONE palette (`barBg`/`barText`,
// the sanctioned pair), which off a feed is that feed's colourway and elsewhere
// the global content palette — so a feed-agnostic launch gets an ink bar over
// ink rules rather than the pane being the one surface in the house with no top.
// -----------------------------------------------------------------------------
function ReaderBar({
  sourceName,
  sourceHref,
  sourceKind,
  title,
  titleHref,
  onClose,
  palette,
  frameScheme,
}: {
  sourceName: string | null;
  sourceHref: string | null;
  /** Which overlay a plain left-click on the name should re-root: the source /
   *  publication SURFACE, or a writer's PROFILE. Both are real <Link>s, so
   *  new-tab and copy-link work either way. */
  sourceKind: "surface" | "profile";
  title: string | null;
  titleHref: string | null;
  onClose: () => void;
  palette: VesselPalette;
  /** Handed ON to whichever pane the source link opens, so a source or profile
   *  reached from the reader wears the same feed's colourway the reader does. */
  frameScheme: FeedScheme | null;
}) {
  const discClose = useDiscCloseActive();
  const name = sourceName ? (
    sourceHref ? (
      sourceKind === "surface" ? (
        <InwardLink
          href={sourceHref}
          explain="reader.barSource"
          frameScheme={frameScheme}
        >
          {sourceName}
        </InwardLink>
      ) : (
        <ProfileLink
          href={sourceHref}
          frameScheme={frameScheme}
          className="hover:underline"
          style={{ color: "inherit" }}
          data-explain="reader.barSource"
        >
          {sourceName}
        </ProfileLink>
      )
    ) : (
      sourceName
    )
  ) : null;

  return (
    <div
      className="ah-pane-bar"
      data-explain="reader.bar"
      style={{
        height: PANE_BAR_H,
        background: palette.barBg,
        color: palette.barText,
      }}
    >
      <span className="label-ui ah-reader-bar-source">{name}</span>
      {/* Title and ✕ are ONE group so the half-bar cap is measured where the
          eye measures it — the group's left edge is the furthest inward the
          title can reach. Capping the title alone leaves it starting slightly
          left of the midpoint, because the ✕ and its gap sit to its right. */}
      <span className="ah-reader-bar-end">
        {title && titleHref && (
          <a
            href={titleHref}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-mono-xs ah-reader-bar-title hover:underline"
            style={{ color: "inherit" }}
            title={title}
            data-explain="reader.barTitle"
          >
            {title}
          </a>
        )}
        {/* On the mobile workspace the ∀ disc has already flipped to this
            sheet's X, so the bar draws none (stores/glasshouse.ts::
            useDiscCloseActive — the declaration, not `isMobile`). The title
            keeps its half-bar cap either way: the cap is measured on the bar,
            not on what happens to sit beside it. */}
        {!discClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ah-pane-bar-close"
            style={{ color: "inherit" }}
          >
            ✕
          </button>
        )}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// NativeArticleBody — renders the existing ArticleReader (its gate-pass unlock +
// markdown render run client-side, so no SSR / preRenderedFreeHtml is needed in
// the overlay). Mirrors the prop mapping in app/article/[dTag]/page.tsx.
//
// The fetch itself lives in ReaderOverlay, not here: the bar names the article's
// publication / writer and is pinned outside this scroll body, so the body
// cannot be what resolves it. This component takes the result.
// -----------------------------------------------------------------------------
function NativeArticleBody({
  article,
  error,
  preview,
  focusCommentId,
  scrollRef,
}: {
  article: ArticleMetadata | null;
  error: boolean;
  preview?: { title: string | null; summary: string | null } | null;
  focusCommentId: string | null;
  // Passed straight through to ArticleReader: the pane's scroller, not the
  // document's. See the external branch above for why that matters.
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  if (error) {
    return (
      <div className="px-8 py-16 text-center">
        <p className="text-ui-xs text-grey-600">Couldn’t load this article. Please try again.</p>
      </div>
    );
  }

  if (!article) {
    // Instant preview (audit #6): when the card seeded a title/dek, paint the
    // article's identity on the first frame — in the same typography the loaded
    // ArticleReader header uses, so the body fading in below causes no shift.
    // Falls back to a neutral skeleton when nothing was seeded (search/dashboard).
    if (preview?.title) {
      return (
        <div className="px-6 sm:px-16 md:px-24 py-16">
          <h1
            className="mb-4 font-serif text-black leading-[1.1]"
            style={{
              fontSize: "clamp(2.125rem, 4vw, 2.125rem)",
              fontWeight: 500,
              letterSpacing: "-0.025em",
            }}
          >
            {preview.title}
          </h1>
          {preview.summary && (
            <p className="font-serif text-xl text-grey-600 italic leading-relaxed mt-4 mb-2">
              {preview.summary}
            </p>
          )}
          <div className="slab-rule-4 mb-10 mt-6" />
          <div className="space-y-3 animate-pulse">
            <div className="h-4 bg-grey-100 rounded w-full" />
            <div className="h-4 bg-grey-100 rounded w-5/6" />
            <div className="h-4 bg-grey-100 rounded w-full" />
          </div>
        </div>
      );
    }
    return (
      <div className="px-8 py-16 space-y-3 animate-pulse">
        <div className="h-7 bg-grey-100 rounded w-3/4 mx-auto" />
        <div className="h-4 bg-grey-100 rounded w-full" />
        <div className="h-4 bg-grey-100 rounded w-5/6" />
        <div className="h-4 bg-grey-100 rounded w-full" />
      </div>
    );
  }

  return (
    <ArticleReader
      postId={article.postId}
      focusCommentId={focusCommentId}
      scrollRef={scrollRef}
      article={{
        id: article.nostrEventId,
        pubkey: article.writer.pubkey,
        dTag: article.dTag,
        title: article.title,
        summary: article.summary ?? "",
        content: article.contentFree ?? "",
        publishedAt: article.publishedAt
          ? Math.floor(new Date(article.publishedAt).getTime() / 1000)
          : 0,
        tags: [],
        pricePence: article.pricePence ?? undefined,
        gatePositionPct: article.gatePositionPct ?? undefined,
        isPaywalled: article.isPaywalled,
      }}
      coverImageUrl={article.coverImageUrl ?? null}
      articleDbId={article.id}
      writerName={article.writer.displayName ?? article.writer.username}
      writerUsername={article.writer.username}
      writerAvatar={article.writer.avatar ?? undefined}
      writerId={article.writer.id}
      subscriptionPricePence={
        article.publication?.subscriptionPricePence ??
        article.writer.subscriptionPricePence
      }
      writerSpendThisMonthPence={article.writerSpendThisMonthPence ?? undefined}
      publicationName={article.publication?.name ?? undefined}
      publicationSlug={article.publication?.slug ?? undefined}
    />
  );
}
