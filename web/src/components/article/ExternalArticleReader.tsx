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
// =============================================================================

import React, { useEffect, useState } from "react";
import { externalItems } from "../../lib/api/external-items";
import { externalizeHtml } from "../../lib/external-links";

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
  title: initialTitle,
  siteName: initialSiteName,
  paddingX = "px-6 sm:px-12",
  showSiteName = true,
}: {
  url: string;
  title?: string | null;
  siteName?: string | null;
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

  const displayTitle = article?.title || initialTitle || "";
  const displaySite = article?.siteName || initialSiteName || "";

  return (
    <article>
      {/* Header — separation is whitespace, no rule (sitewide). */}
      <div className={`${paddingX} pt-8 pb-5`}>
        {showSiteName && displaySite && (
          <a
            href={url}
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
              Could not extract this page.
            </p>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-text"
            >
              OPEN IN NEW TAB →
            </a>
          </div>
        )}

        {article && !loading && (
          <>
            <div
              className="font-serif text-[16px] leading-[1.7] text-black [&_p]:mb-4 [&_p:last-child]:mb-0 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-6 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mb-3 [&_h2]:mt-5 [&_h3]:text-base [&_h3]:font-bold [&_h3]:mb-2 [&_h3]:mt-4 [&_blockquote]:border-l-2 [&_blockquote]:border-grey-300 [&_blockquote]:pl-4 [&_blockquote]:text-grey-600 [&_blockquote]:my-4 [&_a]:text-black [&_a]:underline [&_img]:max-w-full [&_img]:h-auto [&_img]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-4 [&_li]:mb-1 [&_pre]:bg-grey-50 [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:text-sm [&_pre]:my-4 [&_code]:font-mono [&_code]:text-sm"
              dangerouslySetInnerHTML={{ __html: externalizeHtml(article.content) }}
            />
            <div className="mt-8">
              <a
                href={url}
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
