"use client";

import React from "react";
import { extractNoteMedia } from "../../lib/media";
import type { Post, MediaItem } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// PostMedia — level-aware media, governed by the §4 matrix media mode.
//
//   "full-width"        (focal)              — hero at natural dimensions + extras
//   "sized"             (feed/parent/reply)  — cropped 16:9 hero + "+N" overflow pill
//   "single-thumbnail"  (quoted)             — one small thumbnail, nothing else
//   "none"              (condensed)          — render nothing
//
// Adapted from VesselCard's MediaBlock. Note media lives inline in the text, so
// for native notes we extract image URLs here (matching VesselCard).
//
// Video is governed by the §4 `video` mode, uniformly across every source
// (ActivityPub/Mastodon, Bluesky HLS, RSS enclosures, …):
//   "static"          (feed/parent/reply) — poster + play glyph; a click does NOT
//                       escape to a new tab, it bubbles to the card so the card
//                       expands (→ focal), where the video then plays.
//   "autoplay-unmute" (focal)             — a real <video>, muted-autoplay with
//                       controls so the reader can unmute. HLS (.m3u8, Bluesky)
//                       plays via hls.js (native on Safari).
//
// Separation rule: link previews use a background fill + padding, no edge lines.
// =============================================================================

type MediaMode = "full-width" | "sized" | "single-thumbnail" | "none";
type VideoMode = "autoplay-unmute" | "static" | "none";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function mediaForPost(post: Post): MediaItem[] {
  if (post.body.media && post.body.media.length > 0) return post.body.media;
  // Native notes carry images inline in the text.
  if (post.type === "note" && post.body.text) {
    return extractNoteMedia(post.body.text) as MediaItem[];
  }
  return [];
}

export function PostMedia({
  post,
  mode,
  video,
  palette,
  density,
}: {
  post: Post;
  mode: MediaMode;
  video: VideoMode;
  palette: VesselPalette;
  density: string;
}) {
  if (mode === "none" || density !== "standard") return null;
  const items = mediaForPost(post);
  if (items.length === 0) return null;

  const hero =
    items.find((m) => m.type === "image") ?? items.find((m) => m.type === "video");
  const linkItems = items.filter((m) => m.type === "link" && m.url);

  // Quoted: a single small thumbnail, nothing else.
  if (mode === "single-thumbnail") {
    const thumb = hero?.type === "image" ? hero.url : hero?.thumbnail;
    if (!thumb) return null;
    return (
      <img
        src={thumb}
        alt={hero?.alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{
          width: 64,
          height: 64,
          objectFit: "cover",
          display: "block",
          marginTop: 6,
          background: palette.interior,
        }}
      />
    );
  }

  if (!hero && linkItems.length === 0) return null;

  const expanded = mode === "full-width";
  const visualCount = items.filter(
    (m) => m.type === "image" || m.type === "video",
  ).length;
  const overflowCount = hero && !expanded ? visualCount - 1 : 0;
  const heroIsVideo = hero?.type === "video";
  // A real, playing element only at focal (autoplay-unmute). Everywhere else a
  // video is a poster + glyph whose click bubbles to the card (→ expand).
  const inlineVideo = heroIsVideo && video === "autoplay-unmute";

  const heroContainerStyle: React.CSSProperties = {
    position: "relative",
    marginTop: 10,
    marginBottom: 6,
    background: palette.interior,
    overflow: "hidden",
    // Static video signals "click to expand"; the inline player owns its cursor.
    cursor: heroIsVideo && !inlineVideo ? "pointer" : undefined,
    ...(expanded ? {} : { aspectRatio: "16 / 9" }),
  };
  const heroImgStyle: React.CSSProperties = expanded
    ? { width: "100%", height: "auto", maxWidth: "100%", display: "block" }
    : { width: "100%", height: "100%", objectFit: "cover", display: "block" };

  const extraVisuals = expanded
    ? items.filter((m) => (m.type === "image" || m.type === "video") && m !== hero)
    : [];

  return (
    <>
      {hero && (
        <div style={heroContainerStyle}>
          {hero.type === "image" && (
            <img
              src={hero.url}
              alt={hero.alt ?? ""}
              loading="lazy"
              referrerPolicy="no-referrer"
              style={heroImgStyle}
            />
          )}
          {inlineVideo && (
            <InlineVideo item={hero} expanded={expanded} />
          )}
          {heroIsVideo && !inlineVideo && (
            <>
              {hero.thumbnail && (
                <img
                  src={hero.thumbnail}
                  alt={hero.alt ?? ""}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  style={heroImgStyle}
                />
              )}
              <PlayGlyph hasPoster={!!hero.thumbnail} />
            </>
          )}
          {overflowCount > 0 && (
            <span
              aria-hidden="true"
              className="font-mono"
              style={{
                position: "absolute",
                right: 8,
                bottom: 8,
                padding: "2px 8px",
                background: "rgb(var(--ah-true-black-rgb) / 0.72)",
                color: "var(--ah-white)",
                fontSize: 11,
                letterSpacing: "0.04em",
              }}
            >
              +{overflowCount}
            </span>
          )}
        </div>
      )}
      {extraVisuals.map((m, i) => {
        const src = m.type === "image" ? m.url : m.thumbnail;
        if (!src) return null;
        return (
          <div
            key={`extra-${i}`}
            style={{
              position: "relative",
              marginBottom: 6,
              background: palette.interior,
              overflow: "hidden",
            }}
          >
            <img
              src={src}
              alt={m.alt ?? ""}
              loading="lazy"
              referrerPolicy="no-referrer"
              style={{ width: "100%", height: "auto", maxWidth: "100%", display: "block" }}
            />
          </div>
        );
      })}
      {linkItems.map((link, i) => (
        <LinkPreview key={i} item={link} palette={palette} />
      ))}
    </>
  );
}

// Inline player for the focal video. Direct files (Mastodon/RSS MP4/WebM) play
// via the native <video src>. HLS playlists (.m3u8 — Bluesky) play natively on
// Safari and via a lazily-imported hls.js everywhere else; if neither can play
// the poster simply remains. Muted so the browser honours autoplay; controls let
// the reader unmute. stopPropagation keeps scrubbing from collapsing the card.
function InlineVideo({ item, expanded }: { item: MediaItem; expanded: boolean }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const isHls = /\.m3u8(\?|#|$)/i.test(item.url);
  // A fatal load failure drops the player for the poster — never a forever
  // spinner (the symptom when a manifest/segment fetch is refused or stalls).
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setFailed(false);
    const el = ref.current;
    if (!el || !isHls) return;
    // Safari (and iOS) play HLS natively.
    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = item.url;
      return;
    }
    let destroyed = false;
    let recovered = false;
    let hls: { destroy: () => void } | null = null;
    void import("hls.js")
      .then(({ default: Hls }) => {
        if (destroyed || !ref.current || !Hls.isSupported()) return;
        const instance = new Hls();
        hls = instance;
        instance.loadSource(item.url);
        instance.attachMedia(ref.current);
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          void ref.current?.play().catch(() => {});
        });
        instance.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          // One recovery attempt for a transient network/media stall; if it
          // fatals again, tear down so the poster stands in.
          if (!recovered && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            recovered = true;
            instance.startLoad();
            return;
          }
          if (!recovered && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            recovered = true;
            instance.recoverMediaError();
            return;
          }
          instance.destroy();
          if (!destroyed) setFailed(true);
        });
      })
      .catch(() => {
        if (!destroyed) setFailed(true);
      });
    return () => {
      destroyed = true;
      hls?.destroy();
    };
  }, [item.url, isHls]);

  // Fatal failure: let the poster stand in rather than a stuck spinner.
  if (failed) {
    return item.thumbnail ? (
      <img
        src={item.thumbnail}
        alt={item.alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={
          expanded
            ? { width: "100%", height: "auto", maxWidth: "100%", display: "block" }
            : { width: "100%", height: "100%", objectFit: "cover", display: "block" }
        }
      />
    ) : null;
  }

  return (
    <video
      ref={ref}
      src={isHls ? undefined : item.url}
      poster={item.thumbnail || undefined}
      muted
      autoPlay
      playsInline
      controls
      preload="metadata"
      onClick={(e) => e.stopPropagation()}
      // Direct files (MP4/WebM) surface load failures here; HLS errors come via
      // hls.js's ERROR event, which manages the element's own error internally.
      onError={() => {
        if (!isHls) setFailed(true);
      }}
      style={{
        width: "100%",
        maxWidth: "100%",
        display: "block",
        background: "var(--ah-true-black)",
        ...(expanded
          ? { height: "auto", maxHeight: "75vh" }
          : { height: "100%", objectFit: "cover" }),
      }}
    />
  );
}

function PlayGlyph({ hasPoster }: { hasPoster: boolean }) {
  return (
    <div
      role="img"
      aria-label="Play video"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: hasPoster ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.06)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: "rgb(var(--ah-white-rgb) / 0.92)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 3.5v9l7-4.5z" style={{ fill: "var(--ah-ink-925)" }} />
        </svg>
      </span>
    </div>
  );
}

// Link preview — background fill + padding, no edge line (separation rule).
function LinkPreview({ item, palette }: { item: MediaItem; palette: VesselPalette }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="no-underline"
      style={{
        display: "flex",
        gap: 12,
        marginTop: 10,
        marginBottom: 6,
        padding: 10,
        background: palette.interior,
      }}
    >
      {item.thumbnail && (
        <img
          src={item.thumbnail}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{
            width: 64,
            height: 64,
            objectFit: "cover",
            background: palette.cardBg,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {item.title && (
          <p className="text-ui-sm font-semibold truncate" style={{ color: palette.cardTitle }}>
            {item.title}
          </p>
        )}
        {item.description && (
          <p
            className="text-ui-xs line-clamp-2"
            style={{ color: palette.cardStandfirst, marginTop: 2 }}
          >
            {item.description}
          </p>
        )}
        <p className="text-mono-xs truncate" style={{ color: palette.cardMeta, marginTop: 2 }}>
          {hostOf(item.url)}
        </p>
      </div>
    </a>
  );
}
