"use client";

import React from "react";
import { stripMediaUrls } from "../../lib/media";
import { externalizeHtml } from "../../lib/external-links";
import { truncateText } from "../../lib/format";
import { ContentWarning } from "../workspace/ContentWarning";
import { PollDisplay } from "../workspace/PollDisplay";
import type { Post } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// PostBody — title / summary / text / html for any Post, governed by body mode.
//
//   "expanded"  (focal/parent/reply) — full text, no clamp (thread context never clips)
//   "full"      (feed)               — full text with a collapse-truncate for long bodies
//   "one-line"  (condensed level)    — a single truncated line
//   "headline"  (headline density)   — the whole headline and nothing under it; a
//                                      note keeps its whole body, an article drops
//                                      its standfirst entirely.
//
// bodyPx arrives ALREADY scaled by the level's textScale (PostCard does the
// multiply + readability floor). Content warnings wrap the body; polls render
// read-only this phase (voting is a Phase-3 concern). Articles render
// title + standfirst only — their body opens in the reader pane (§3.1).
// =============================================================================

type BodyMode = "expanded" | "full" | "one-line" | "headline";

// Modes that render a body verbatim — no character truncate, no line clamp.
const UNTRUNCATED: ReadonlySet<BodyMode> = new Set<BodyMode>(["expanded", "headline"]);

// Poll voting is supplied by usePostInteractions (external interact-back); absent
// ⇒ the poll renders read-only (native, tiers C/D, or non-interactive renders).
export interface PollVote {
  canVote: boolean;
  voting: boolean;
  onVote: (choices: number[]) => void;
}

const NOTE_COLLAPSE_CHARS = 220; // matches NoteVesselCard collapse
const EXTERNAL_COLLAPSE_CHARS = 200; // matches ExternalVesselCard collapse
const ONE_LINE_CHARS = 90;

// Bare http(s) URLs in plain-text bodies (HTML/markdown notes already carry real
// <a>). We linkify only in the expanded/full text modes (a truncated one-line
// URL is meaningless). Trailing sentence punctuation is trimmed off the link so
// "see https://x.com." doesn't swallow the period; an unbalanced closing bracket
// is trimmed too, but a ')' is kept when the URL itself opened one (wiki links).
const URL_RE = /(https?:\/\/[^\s<]+)/g;

function linkifyText(text: string, palette: VesselPalette): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0];
    let trail = "";
    // Trim trailing punctuation unlikely to belong to the URL.
    const tm = url.match(/[.,;:!?)\]]+$/);
    if (tm) {
      let cut = tm[0];
      // Keep a ')'/']' the URL itself balances (e.g. Wikipedia anchors).
      while (
        cut.length &&
        ((cut.endsWith(")") &&
          (url.slice(0, url.length - cut.length).match(/\(/g)?.length ?? 0) >
            (url.slice(0, url.length - cut.length).match(/\)/g)?.length ?? 0)) ||
          (cut.endsWith("]") &&
            (url.slice(0, url.length - cut.length).match(/\[/g)?.length ?? 0) >
              (url.slice(0, url.length - cut.length).match(/\]/g)?.length ?? 0)))
      ) {
        cut = cut.slice(0, -1);
      }
      if (cut) {
        trail = cut;
        url = url.slice(0, url.length - cut.length);
      }
    }
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a
        key={key++}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ color: palette.crimson, textDecoration: "underline" }}
      >
        {url}
      </a>,
    );
    if (trail) parts.push(trail);
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function PostBody({
  post,
  bodyPx,
  mode,
  palette,
  pollVote,
}: {
  post: Post;
  bodyPx: number;
  mode: BodyMode;
  palette: VesselPalette;
  pollVote?: PollVote;
}) {
  const body = (
    <BodyInner post={post} bodyPx={bodyPx} mode={mode} palette={palette} pollVote={pollVote} />
  );
  if (post.body.contentWarning) {
    return (
      <ContentWarning warningText={post.body.contentWarning} palette={palette}>
        {body}
      </ContentWarning>
    );
  }
  return body;
}

function BodyInner({
  post,
  bodyPx,
  mode,
  palette,
  pollVote,
}: {
  post: Post;
  bodyPx: number;
  mode: BodyMode;
  palette: VesselPalette;
  pollVote?: PollVote;
}) {
  const titlePx = Math.round(bodyPx + 3.5);

  // Title (articles, and external items that carry one).
  const title = post.body.title ? (
    <h3
      className="font-serif"
      style={{
        color: palette.cardTitle,
        fontSize: titlePx,
        lineHeight: 1.25,
        fontWeight: 600,
        ...(mode === "one-line"
          ? ({
              display: "-webkit-box",
              WebkitLineClamp: 1,
              WebkitBoxOrient: "vertical" as const,
              overflow: "hidden",
            } as React.CSSProperties)
          : {}),
      }}
    >
      {post.body.title}
    </h3>
  ) : null;

  // Articles: title + standfirst only (body opens in the reader pane). Under the
  // headline density the title carries the card alone, so the standfirst goes.
  if (post.type === "article") {
    const summary = post.body.summary || post.body.text || "";
    return (
      <>
        {title}
        {summary && mode !== "one-line" && mode !== "headline" && (
          <p
            className="font-serif"
            style={{
              color: palette.cardStandfirst,
              fontSize: bodyPx,
              lineHeight: 1.5,
              marginTop: title ? 4 : 0,
            }}
          >
            {mode === "expanded" ? summary : truncateText(summary, EXTERNAL_COLLAPSE_CHARS)}
          </p>
        )}
      </>
    );
  }

  // External notes prefer sanitised HTML when present.
  if (post.body.html) {
    const clampStyle: React.CSSProperties =
      UNTRUNCATED.has(mode)
        ? {}
        : {
            display: "-webkit-box",
            WebkitLineClamp: mode === "one-line" ? 1 : 8,
            WebkitBoxOrient: "vertical" as const,
            overflow: "hidden",
          };
    return (
      <>
        {title}
        <div
          className="post-body-html whitespace-pre-wrap break-words"
          style={{
            color: palette.cardTitle,
            fontSize: bodyPx,
            lineHeight: 1.5,
            marginTop: title ? 4 : 0,
            ...clampStyle,
          }}
          dangerouslySetInnerHTML={{ __html: externalizeHtml(post.body.html) }}
        />
        {post.body.poll && <PollBlock post={post} palette={palette} pollVote={pollVote} />}
      </>
    );
  }

  // Native notes + plain-text external: strip inline media URLs for display.
  const raw = post.body.text ?? "";
  const { displayText } = stripMediaUrls(raw);
  const text = UNTRUNCATED.has(mode)
    ? displayText
    : mode === "one-line"
      ? truncateText(displayText, ONE_LINE_CHARS)
      : truncateText(displayText, NOTE_COLLAPSE_CHARS);

  return (
    <>
      {title}
      {text && (
        <p
          className="whitespace-pre-wrap break-words"
          style={{
            color: palette.cardTitle,
            fontSize: bodyPx,
            lineHeight: 1.5,
            marginTop: title ? 4 : 0,
            ...(mode === "one-line"
              ? ({
                  display: "-webkit-box",
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: "vertical" as const,
                  overflow: "hidden",
                } as React.CSSProperties)
              : {}),
          }}
        >
          {mode === "one-line" ? text : linkifyText(text, palette)}
        </p>
      )}
      {/* Poll stays hidden under the headline density, alongside media and the
          action row — the whole-note rule is about the note's TEXT. */}
      {post.body.poll && mode !== "one-line" && mode !== "headline" && (
        <PollBlock post={post} palette={palette} pollVote={pollVote} />
      )}
    </>
  );
}

// Poll voting comes from usePostInteractions (external interact-back). Absent ⇒
// read-only (native, tiers C/D, or non-interactive renders).
function PollBlock({
  post,
  palette,
  pollVote,
}: {
  post: Post;
  palette: VesselPalette;
  pollVote?: PollVote;
}) {
  if (!post.body.poll) return null;
  return (
    <PollDisplay
      poll={post.body.poll}
      canVote={pollVote?.canVote ?? false}
      onVote={pollVote?.onVote ?? (() => {})}
      voting={pollVote?.voting ?? false}
      palette={palette}
    />
  );
}
