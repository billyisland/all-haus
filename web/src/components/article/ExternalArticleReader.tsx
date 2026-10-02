"use client";

// =============================================================================
// ExternalArticleReader — UNIVERSAL-POST-ADR §3.1 / Phase R
//
// The readable-content region for an EXTERNAL article: fetches reader-mode HTML
// via GET /extract?url= and renders header (site · title · byline) + body +
// "open in new tab" footer. NO scrim and NO close chrome — the caller supplies
// the frame:
//   - ReaderOverlay wraps this in the workspace overlay (scrim + pane + close).
//   - /read/[postId] wraps this in a full-page container (direct URL / new tab).
//
// Lifted out of the old workspace/ReaderPane.tsx (now deleted) so the overlay and
// the addressable route share one reader. Separation is whitespace, per the
// sitewide no-thin-line rule.
//
// VIDEO (2026-09-02) reaches the pane by two routes, and it needed both.
//   • In the BODY — /extract's HTML, which now keeps <video> and a host-limited
//     <iframe> (shared/src/lib/sanitize.ts). That covers an embed on the origin
//     page, which is where most of them live.
//   • ABOVE the body — the item's OWN media (`media`), which the origin page may
//     not carry at all: an RSS <enclosure> or <media:content> IS the post for a
//     video feed. The card has always played these; the pane showed the extract
//     alone, which is why opening a video item was where the video went away.
// =============================================================================

import React, { useEffect, useRef, useState, type RefObject } from "react";
import { externalItems } from "../../lib/api/external-items";
import { externalizeHtml, safeHttpUrl } from "../../lib/external-links";
import { InlineVideo } from "../post/PostMedia";
import { embedFrameSrc } from "../../lib/media-embed";
import type { MediaItem } from "../../lib/post/types";
import { useReadingPosition } from "../../hooks/useReadingPosition";
import { useReadingLog } from "../../hooks/useReadingLog";
import { useBodyImageLightbox } from "../../hooks/useBodyImageLightbox";
import { useAuth } from "../../stores/auth";

interface ExtractResult {
  title: string;
  content: string;
  siteName: string;
  excerpt: string;
  byline: string;
  length: number;
}

export function ExternalArticleReader({
  url,
  postId,
  scrollRef,
  title: initialTitle,
  siteName: initialSiteName,
  paddingX = "px-6 sm:px-12",
  showSiteName = true,
  media,
}: {
  url: string;
  /** The piece's `post_id` — the key the reading log and the scroll-position
   *  table both take (READING-LOG-AND-LIBRARY-ADR D7/D8). Both surfaces that
   *  mount this reader already hold one: it is `/read/:postId`'s own URL, and
   *  the overlay's external target carries it. Absent ⇒ neither is recorded. */
  postId?: string | null;
  /** The element that actually scrolls. Omitted on the full-page route (the
   *  document scrolls); ReaderOverlay passes the pane's own scrolling div —
   *  without it the resume hook measures a document that never moves and
   *  records a ratio of 0 forever, which reads as perfectly ordinary (D9). */
  scrollRef?: RefObject<HTMLElement | null>;
  title?: string | null;
  siteName?: string | null;
  /** The item's OWN media, when the caller has the Post in hand. Only VIDEO is
   *  rendered here: the images are the extracted body's own images (printing
   *  them again would double every picture in the piece), and a link preview in
   *  a reader is a preview of the thing being read. Absent on any surface with
   *  no Post — the body still renders. */
  media?: MediaItem[] | null;
  /** Horizontal padding utility for the header + body columns. Responsive: a
   *  tight gutter on mobile (where the reader fills the viewport) widening on
   *  larger viewports. The reader-pane overlay passes a wider top-end value for
   *  roomier desktop side margins; the full-page route keeps the default. */
  paddingX?: string;
  /** Print the site name above the title. False in the workspace reader
   *  overlay, whose bar carries the source at its left end (ReaderOverlay) —
   *  the two together would state the same identity twice, three lines apart.
   *  The full-page /read/:postId route has no bar, so it keeps the default. */
  showSiteName?: boolean;
}) {
  const [article, setArticle] = useState<ExtractResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const { user } = useAuth();

  // Resume and the reading log reach the EXTERNAL reader here (D9), and this
  // is one component covering two surfaces — the workspace overlay's external
  // branch and /read/:postId — rather than two builds. It depends on D8: an
  // external post has no `articles` row, so until reading_positions moved onto
  // post_id there was nothing to key a position on, and resume worked on native
  // pieces only — an arbitrary split a reader experiences as the feature being
  // broken half the time.
  useReadingPosition({ postId, enabled: !!user, scrollRef });
  useReadingLog(postId, !!user);

  useEffect(() => {
    let cancelled = false;
    if (!url) {
      setArticle(null);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    externalItems
      .extract(url)
      .then((result) => {
        if (!cancelled) setArticle(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Body pictures open the lightbox, as the native reader's do.
  const bodyRef = useRef<HTMLDivElement>(null);
  useBodyImageLightbox(bodyRef, loading ? null : article?.content);

  const displayTitle = article?.title || initialTitle || "";
  const displaySite = article?.siteName || initialSiteName || "";
  const videos = (media ?? []).filter((m) => m.type === "video" && m.url);

  return (
    <article>
      {/* Header — separation is whitespace, no rule (sitewide). */}
      <div className={`${paddingX} pt-8 pb-5`}>
        {showSiteName && displaySite && (
          <a
            href={safeHttpUrl(url)}
            target="_blank"
            rel="noopener noreferrer"
            className="label-ui text-grey-600 hover:text-black transition-colors mb-2 inline-block"
          >
            {displaySite}
          </a>
        )}
        {displayTitle && (
          <h1 className="font-serif text-2xl leading-snug text-black">
            {displayTitle}
          </h1>
        )}
        {article?.byline && (
          <p className="text-ui-xs text-grey-600 mt-2">{article.byline}</p>
        )}
      </div>

      {/* The item's own video, above the body.
          Deliberately OUTSIDE the loading / error / article branching below: an
          enclosure is a fact the caller already had, so it plays while the
          extract is in flight and — the case that matters — it still plays when
          extraction FAILS, which is exactly when a video-only item (a YouTube
          channel feed, a podcast) has nothing else to show. */}
      {videos.length > 0 && (
        <div className={`${paddingX} pb-2`}>
          {videos.map((item, i) => {
            const frameSrc = embedFrameSrc(item.url);
            return (
              <div key={`v-${i}`} className="mb-4">
                {frameSrc ? (
                  // A provider watch URL is a page, not a file — only the
                  // provider's player plays it (lib/media-embed).
                  <iframe
                    src={frameSrc}
                    title={item.title ?? "Video"}
                    allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
                    allowFullScreen
                    loading="lazy"
                    referrerPolicy="strict-origin-when-cross-origin"
                    style={{
                      width: "100%",
                      aspectRatio: "16 / 9",
                      display: "block",
                      border: 0,
                      background: "var(--ah-true-black)",
                    }}
                  />
                ) : (
                  // A real file — the card's player, so HLS and the poster
                  // fallback behave identically in both places.
                  <InlineVideo item={item} expanded />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Body */}
      <div className={`${paddingX} pb-8`}>
        {loading && (
          <div className="space-y-3 animate-pulse">
            <div className="h-4 bg-grey-100 rounded w-full" />
            <div className="h-4 bg-grey-100 rounded w-5/6" />
            <div className="h-4 bg-grey-100 rounded w-4/5" />
            <div className="h-4 bg-grey-100 rounded w-full" />
            <div className="h-4 bg-grey-100 rounded w-3/4" />
          </div>
        )}

        {error && (
          <div className="text-center py-8">
            <p className="text-ui-xs text-grey-600 mb-4">
              Couldn’t pull the text out of this page. You can read it on the original site instead.
            </p>
            <a
              href={safeHttpUrl(url)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-text"
            >
              OPEN IN NEW TAB →
            </a>
          </div>
        )}

        {/* CAPTIONS (2026-09-12). A picture caption reaches the client as
            <figure><figcaption> — the gateway's extract route normalises every
            provable one into that shape before sanitising, since the class that
            said "caption" on the origin page does not survive Readability or the
            sanitiser (gateway/src/lib/article-captions.ts). The VOICE is not
            spelled here: `ah-caption-voice` (globals.css) is the one home, taken
            by this reader, the native `.prose` reader and the editor's own node
            view alike — three surfaces that must agree, since a caption written
            in one is read in the others. An uncaptioned picture keeps the body
            rhythm ([&_img]:my-4); inside a figure the figure owns the spacing. */}
        {article && !loading && (
          <>
            <div
              ref={bodyRef}
              className="ah-caption-voice font-serif text-[16px] leading-[1.7] text-black [&_p]:mb-4 [&_p:last-child]:mb-0 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-6 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mb-3 [&_h2]:mt-5 [&_h3]:text-base [&_h3]:font-bold [&_h3]:mb-2 [&_h3]:mt-4 [&_blockquote]:border-l-2 [&_blockquote]:border-grey-300 [&_blockquote]:pl-4 [&_blockquote]:text-grey-600 [&_blockquote]:my-4 [&_a]:text-black [&_a]:underline [&_img]:max-w-full [&_img]:h-auto [&_img]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-4 [&_li]:mb-1 [&_pre]:bg-grey-50 [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:text-sm [&_pre]:my-4 [&_code]:font-mono [&_code]:text-sm [&_iframe]:w-full [&_iframe]:aspect-video [&_iframe]:my-4 [&_iframe]:block [&_iframe]:border-0 [&_video]:w-full [&_video]:h-auto [&_video]:my-4 [&_video]:block [&_audio]:w-full [&_audio]:my-4 [&_audio]:block"
              dangerouslySetInnerHTML={{ __html: externalizeHtml(article.content) }}
            />
            <div className="mt-8">
              <a
                href={safeHttpUrl(url)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-text"
              >
                OPEN IN NEW TAB →
              </a>
            </div>
          </>
        )}
      </div>
    </article>
  );
}
