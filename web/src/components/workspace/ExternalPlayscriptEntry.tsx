"use client";

import type { ExternalThreadEntry } from "../../lib/api/feeds";
import { type VesselPalette, TEXT_SIZE_PX, DEFAULT_TEXT_SIZE } from "./tokens";
import { Byline } from "./Byline";
import { externalizeHtml } from "../../lib/external-links";

interface Props {
  entry: ExternalThreadEntry;
  replyingTo: { name: string } | null;
  palette: VesselPalette;
  onReply?: () => void;
  replyActive?: boolean;
  // Re-roots the conversation onto this entry. When provided, the entry body
  // (byline + dialogue) becomes clickable; the Reply control stops propagation
  // so it keeps its own behaviour.
  onEntryClick?: (entry: ExternalThreadEntry) => void;
  // Reading-content size in px, inherited from the host card.
  bodyPx?: number;
}

export function ExternalPlayscriptEntry({
  entry,
  replyingTo,
  palette,
  onReply,
  replyActive,
  onEntryClick,
  bodyPx = TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
}: Props) {
  // Reply bylines match main-card bylines (task 9b): the shared Byline carries
  // name · time; the non-adjacent-parent "→ NAME" affordance rides as
  // `replyingTo`. The bold-`Name:` playscript convention is dropped.
  const publishedAtUnix = Math.floor(
    new Date(entry.publishedAt).getTime() / 1000,
  );
  const clickable = !!onEntryClick;
  return (
    <div
      className="group relative"
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={
        clickable
          ? (e) => {
              e.stopPropagation();
              onEntryClick(entry);
            }
          : undefined
      }
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onEntryClick(entry);
              }
            }
          : undefined
      }
      style={clickable ? { cursor: "pointer" } : undefined}
    >
      {/* The speaker is an arbitrary external participant with no internal
          surface, so the byline is plain text — never the host item's
          /source link, and never a route out to the origin platform (mirrors
          QuotedPostTile). The §VI.3 constructed external author profile will
          give these a real destination later. */}
      <Byline
        name={entry.authorName || entry.authorHandle}
        publishedAt={publishedAtUnix}
        replyingTo={replyingTo}
        palette={palette}
        className="mb-1"
      />

      {/* Dialogue line */}
      <div className="mt-1">
        {entry.contentHtml ? (
          <div
            className="font-sans [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:underline"
            style={{ color: palette.cardTitle, fontSize: bodyPx, lineHeight: 1.5 }}
            dangerouslySetInnerHTML={{ __html: externalizeHtml(entry.contentHtml) }}
          />
        ) : (
          <p
            className="font-sans whitespace-pre-wrap"
            style={{ color: palette.cardTitle, fontSize: bodyPx, lineHeight: 1.5 }}
          >
            {entry.contentText}
          </p>
        )}
      </div>

      {/* Action row: Reply (timestamp now lives in the byline) */}
      <div className="mt-2 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-400">
        {onReply ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReply();
            }}
            className="transition-opacity hover:opacity-70"
            style={{
              color: replyActive ? palette.cardTitle : undefined,
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            Reply
          </button>
        ) : (
          <span>Reply</span>
        )}
      </div>
    </div>
  );
}
