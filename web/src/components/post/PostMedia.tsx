"use client";

import React from "react";
import { extractNoteMedia } from "../../lib/media";
import { safeHttpUrl } from "../../lib/external-links";
import { EnlargeableImage } from "../ui/EnlargeableImage";
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
    const thumbStyle: React.CSSProperties = {
      width: 64,
      height: 64,
      objectFit: "cover",
      display: "block",
      background: palette.interior,
    };
    // A video's poster is not a picture — it stands for a clip, and its click
    // belongs to the card (→ expand → play), exactly as the hero's does.
    return hero?.type === "image" ? (
      <EnlargeableImage
        src={thumb}
        alt={hero.alt ?? ""}
        style={thumbStyle}
        wrapperStyle={{ marginTop: 6, width: 64, height: 64 }}
      />
    ) : (
      <img
        src={thumb}
        alt={hero?.alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{ ...thumbStyle, marginTop: 6 }}
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
            <EnlargeableImage
              src={hero.url}
              alt={hero.alt ?? ""}
              style={heroImgStyle}
              // The button is the box the layout sees, so it takes the hero's
              // geometry: a collapsed hero fills its 16:9 crop in both axes, an
              // expanded one is full-width at the picture's own height.
              wrapperStyle={
                expanded ? { width: "100%" } : { width: "100%", height: "100%" }
              }
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
        const extraStyle: React.CSSProperties = {
          width: "100%",
          height: "auto",
          maxWidth: "100%",
          display: "block",
        };
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
            {m.type === "image" ? (
              <EnlargeableImage
                src={src}
                alt={m.alt ?? ""}
                style={extraStyle}
                wrapperStyle={{ width: "100%" }}
              />
            ) : (
              <img
                src={src}
                alt={m.alt ?? ""}
                loading="lazy"
                referrerPolicy="no-referrer"
                style={extraStyle}
              />
            )}
          </div>
        );
      })}
      {linkItems.map((link, i) => (
        <LinkPreview key={i} item={link} palette={palette} />
      ))}
    </>
  );
}

// Inline player for the focal video. Also the reader pane's player, via the
// export (ExternalArticleReader) — the pane shows an item's own enclosure above
// the extracted body, and one player means HLS, the poster fallback and the
// no-autoplay-with-sound posture are decided once.
//
// Direct files (Mastodon/RSS MP4/WebM) play
// via the native <video src>. HLS playlists (.m3u8 — Bluesky) play natively on
// Safari and via a lazily-imported hls.js everywhere else; if neither can play
// the poster simply remains. Muted so the browser honours autoplay; controls let
// the reader unmute. stopPropagation keeps scrubbing from collapsing the card.
export function InlineVideo({ item, expanded }: { item: MediaItem; expanded: boolean }) {
  const isHls = /\.m3u8(\?|#|$)/i.test(item.url);
  // A fatal load failure drops the player for the poster — never a forever
  // spinner (the symptom when a manifest/segment fetch is refused or stalls).
  const [failed, setFailed] = React.useState(false);

  // THE ELEMENT IS STATE, NOT A BARE REF, BECAUSE IT IS NOT THE SAME ELEMENT
  // FOR THE COMPONENT'S WHOLE LIFE. A fatal failure swaps the <video> for the
  // poster <img>, and the next clip swaps it back — a NEW node. Every effect
  // below is about a particular element (release it, observe it, attach hls.js
  // to it), so each must run again when that element changes; a mount-time
  // `ref.current` capture goes on addressing the node that failed. The symptom
  // was clip 2 playing off-screen with sound, leaving its OS media control
  // behind on close, and an HLS clip after a failed one never attaching at all
  // (the effect ran while the poster was up and `ref.current` was null).
  //
  // A callback ref rather than `useRef` because a ref assignment does not
  // re-render: React would swap the node and nothing would be told.
  const [el, setEl] = React.useState<HTMLVideoElement | null>(null);

  // A NEW CLIP GETS A FRESH CHANCE AT THE PLAYER — and this reset is keyed on
  // the item ALONE. Folded into the element effect below it would undo the
  // very failure that swapped the element away: poster up → `el` null → reset
  // → <video> back → same fatal error → poster, forever.
  React.useEffect(() => {
    setFailed(false);
  }, [item.url]);

  React.useEffect(() => {
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
        if (destroyed || !Hls.isSupported()) return;
        const instance = new Hls();
        hls = instance;
        instance.loadSource(item.url);
        instance.attachMedia(el);
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          void el.play().catch(() => {});
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
  }, [item.url, isHls, el]);

  // RELEASING THE ELEMENT ON UNMOUNT IS NOT HOUSEKEEPING. Removing a playing
  // <video> from the document pauses it (the spec says so, and Chromium obeys),
  // but it does NOT release it: the detached element keeps readyState 4, its
  // buffered data and its source, so the browser still holds a live media
  // player for it — which is what the OS "now playing" control is, and why a
  // clip you clicked away from is still sitting on a GNOME lock screen minutes
  // later, offering to resume. It clears when the element is reset or collected,
  // and nothing here was doing the first. Measured, not assumed: after removal
  // an element reads {paused: true, readyState: 4, networkState: 1}, and only
  // pause + removeAttribute("src") + load() takes it to {0, 0}.
  //
  // The HLS path already did this by accident — hls.js's own detachMedia ends in
  // removeAttribute("src") + load(), so `hls.destroy()` in the effect above
  // released the element and a Bluesky clip left no notification behind. The
  // paths that leaked are the ones with no teardown at all: a direct file
  // (Mastodon/RSS MP4, the reader pane's enclosure player) and the native-HLS
  // branch, which assigns `el.src` and returns without a cleanup.
  //
  // Keyed on the ELEMENT, never on `item.url`: an ordinary skip to the next
  // clip keeps the same <video> node and only re-points its src, so a
  // url-keyed teardown would run AFTER the re-render and blank the player we
  // had just re-pointed. The element changes only when React really has
  // replaced the node (the poster swap above), which is exactly when the old
  // one needs releasing.
  React.useEffect(() => {
    if (!el) return;
    return () => {
      el.pause();
      // Not `src = ""`, which resolves against the document and sends the
      // element off to load the page itself as media.
      el.removeAttribute("src");
      el.load();
    };
  }, [el]);

  // A PLAYER THAT HAS LEFT THE VIEW STOPS, AND ONLY WHAT WE STOPPED RESUMES.
  // Card expansion is stored per FEED (WorkspaceView's `expandedByFeed`), so
  // opening a card in another vessel leaves this one focal and playing, as does
  // scrolling it out of sight in its own; nothing unmounts it until the whole
  // vessel parks. Chrome already pauses a MUTED autoplaying video that is not
  // visible — which is exactly why this was invisible until someone unmuted
  // one, the case where the sound then follows you around the workspace.
  //
  // The flag is the substance, not the observer. Resuming on re-entry
  // unconditionally would un-pause a video the READER had deliberately paused,
  // and a control that undoes the press you just made is worse than no control:
  // so we resume only what we ourselves stopped. A reader's own pause clears
  // nothing, because we never set the flag for it.
  //
  // Ancestor clipping is in IntersectionObserver's model, so the viewport root
  // is right for both surfaces — the vessel's scroll body and the Glasshouse
  // pane clip the player out of intersection without either needing to be named
  // as a root. Default threshold: a player still half on screen keeps playing.
  const autoPausedRef = React.useRef(false);
  React.useEffect(() => {
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) {
        if (!el.paused) {
          autoPausedRef.current = true;
          el.pause();
        }
      } else if (autoPausedRef.current) {
        autoPausedRef.current = false;
        void el.play().catch(() => {});
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);

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
      ref={setEl}
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
      href={safeHttpUrl(item.url)}
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
