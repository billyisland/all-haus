"use client";

import React, { useEffect, useState } from "react";
import { externalItems, type ParentItem } from "../../lib/api/feeds";
import { formatDateRelative, truncateText } from "../../lib/format";
import { externalizeHtml, safeHttpUrl } from "../../lib/external-links";
import { EnlargeableImage } from "../ui/EnlargeableImage";
import type { VesselPalette } from "./tokens";

interface Props {
  itemId: string;
  // The HOST card renders its own body in full ⇒ this tile drops its collapse
  // truncate and shows the quoted post whole. Set by QuotedEmbed from the host's
  // resolved body mode — the point being that reading a quoted note should never
  // require opening it, which re-roots the thread away from the conversation.
  expanded?: boolean;
  palette: VesselPalette;
  // When set, the tile is clickable and re-roots the thread onto the quoted
  // post (the host wires this to thread.reroot). Absent ⇒ static tile.
  onOpen?: () => void;
}

// Shape of the quoted post's own media (mirrors the feed media array). ParentItem
// types media as unknown[]; we narrow it here for rendering.
interface QuoteMedia {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  title?: string;
  description?: string;
}

// Module-level cache keyed by itemId — survives card collapse/expand cycles.
const cache = new Map<string, ParentItem | null>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// A quote post embeds another post. We render that quoted post as a nested
// mini-card in our own idiom — QUOTING label, mono-caps byline, content, and the
// quoted post's own media — so a Bluesky/Mastodon quote reads here the way it
// does there. The author is plain text, never a link out to the origin platform
// (the quoted author may not be a subscribed source, so we don't fabricate an
// internal /source link either; CARD-BEHAVIOUR-ADR byline-routing rule).
export function QuotedPostTile({ itemId, expanded, palette, onOpen }: Props) {
  const [quote, setQuote] = useState<ParentItem | null>(
    cache.get(itemId) ?? null,
  );
  const [loading, setLoading] = useState(!cache.has(itemId));

  useEffect(() => {
    if (cache.has(itemId)) return;

    externalItems
      .quote(itemId)
      .then((res) => {
        cache.set(itemId, res.quote);
        setQuote(res.quote);
      })
      .catch(() => {
        cache.set(itemId, null);
      })
      .finally(() => setLoading(false));
  }, [itemId]);

  if (loading) {
    return (
      <div
        className="mt-2.5 mb-1.5 animate-pulse p-2.5"
        style={{ opacity: 0.4, background: palette.quoteBg }}
      >
        <div
          className="h-3 rounded mb-2"
          style={{ width: "40%", background: palette.quoteMeta }}
        />
        <div
          className="h-3 rounded"
          style={{ width: "80%", background: palette.quoteMeta }}
        />
      </div>
    );
  }

  if (!quote) return null;

  const name = quote.authorName || quote.authorHandle || "Unknown";
  const timestamp = formatDateRelative(quote.publishedAt);
  const body = quote.contentHtml || quote.contentText;
  const media = (quote.media ?? []) as QuoteMedia[];
  const image = media.find((m) => m.type === "image");
  const link = media.find((m) => m.type === "link" && m.url);

  // A COLLAPSED tile is capped by LINE COUNT, and the cap is what both protocols
  // obey. The plain-text char truncate below cannot govern the HTML path (there
  // is no safe character cut through markup), so for years a Mastodon quote
  // rendered whole inside a collapsed card while a Bluesky one clipped at 240 —
  // the same inset reading differently purely by protocol. Four lines is the
  // 240-char sibling at a typical column width; the char truncate stays under it
  // as a DOM-size cap, and on a narrow column the line cap is the one that bites.
  // Expanded, neither applies — see the `expanded` contract above.
  const clampStyle: React.CSSProperties = expanded
    ? {}
    : {
        display: "-webkit-box",
        WebkitLineClamp: 4,
        WebkitBoxOrient: "vertical" as const,
        overflow: "hidden",
      };

  return (
    <div
      className={`mt-2.5 mb-1.5 p-2.5${onOpen ? " cursor-pointer hover:opacity-90" : ""}`}
      style={{ background: palette.quoteBg }}
      {...(onOpen
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-label": `Open quoted post by ${name}`,
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              onOpen();
            },
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onOpen();
              }
            },
          }
        : {})}
    >
      <div
        className="font-mono text-[10px] uppercase tracking-[0.06em] mb-1.5"
        style={{ color: palette.quoteMeta }}
      >
        ↱ Quoting {name} · {timestamp}
      </div>
      {body && (
        <div
          className={`text-[13px] leading-[1.5] [&_p]:mb-2 [&_p:last-child]:mb-0${
            quote.contentHtml ? "" : " whitespace-pre-wrap break-words"
          }`}
          style={{ color: palette.quoteText, ...clampStyle }}
          dangerouslySetInnerHTML={
            quote.contentHtml
              ? { __html: externalizeHtml(quote.contentHtml) }
              : undefined
          }
        >
          {!quote.contentHtml
            ? expanded
              ? body
              : truncateText(body, 240)
            : undefined}
        </div>
      )}
      {image && (
        <EnlargeableImage
          src={image.url}
          alt={image.alt ?? ""}
          wrapperClassName="mt-2 w-full"
          className="w-full"
          style={{
            display: "block",
            background: palette.quoteBg,
            // Expansion is transitive here too: a collapsed tile shows a cropped
            // 200px band, an expanded one shows the picture whole at its natural
            // aspect — the house treatment for an expanded hero (PostMedia's
            // "full-width"). Cropping inside an expanded card leaves the reader
            // the same dead end the clipped text did.
            ...(expanded
              ? { height: "auto" }
              : { maxHeight: 200, objectFit: "cover" as const }),
          }}
        />
      )}
      {link && (
        <a
          href={safeHttpUrl(link.url)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="no-underline mt-2"
          style={{
            display: "flex",
            gap: 10,
            padding: 8,
            background: palette.cardBg,
          }}
        >
          {link.thumbnail && (
            <img
              src={link.thumbnail}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              style={{
                width: 48,
                height: 48,
                objectFit: "cover",
                background: palette.interior,
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            {link.title && (
              <p
                className="text-ui-xs font-semibold truncate"
                style={{ color: palette.cardTitle }}
              >
                {link.title}
              </p>
            )}
            <p
              className="text-mono-xs truncate"
              style={{ color: palette.cardMeta, marginTop: 2 }}
            >
              {hostOf(link.url)}
            </p>
          </div>
        </a>
      )}
    </div>
  );
}
