"use client";

import React from "react";
import { publishReply, REPLY_CHAR_LIMIT } from "../../lib/replies";
import { failureSentence } from "../../lib/api/client";
import { useMediaAttachments } from "../../hooks/useMediaAttachments";
import { MediaPreview } from "../ui/MediaPreview";
import { InlineReplyPanel } from "./InlineReplyPanel";
import type { ReplyTarget } from "../../lib/post/reply-target";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// NativeReplyBox — a reply is written WHERE IT IS BEING MADE.
//
// The card's Reply used to open a Glasshouse over the floor: the whole screen
// frosted over, the post being replied to gone from view, for a sentence. A
// reply belongs to a conversation the reader is already inside, so it is
// composed in situ — a small field in the card's own footer, in the same slot
// and the same panel as the external `InlineReplyBox` (`InlineReplyPanel`).
// The two Glasshouse composers keep NOTE and QUOTE, which are new top-level
// posts and do deserve the screen.
//
// THE LIMIT IS THE GATEWAY'S. `POST /replies` accepts 2,000 characters
// (`gateway/src/routes/replies.ts::REPLY_CHAR_LIMIT`); the overlay was
// enforcing the NOTE's 1,000 on replies, refusing half of what the server
// would have taken. The number lives once, in `lib/replies.ts`, beside the
// publish call both reply composers share.
//
// ⌘/CTRL+ENTER SENDS, ESCAPE CLOSES — the gesture of the box already sitting
// in this slot (`InlineReplyBox`), not the Glasshouse composers' bare Enter.
// One card, one gesture; and a bare Enter inside a field this small is a
// half-written reply published by a line break.
// =============================================================================

export function NativeReplyBox({
  target,
  palette,
  onClose,
  onPublished,
}: {
  target: ReplyTarget;
  palette: VesselPalette;
  onClose: () => void;
  /** Fired after the reply is indexed. `publishReply` has already told every
   *  mounted conversation (`stores/threadRefresh`); this is for the HOST card,
   *  which may want to show the conversation the reply just joined. */
  onPublished?: () => void;
}) {
  const [content, setContent] = React.useState("");
  const [publishing, setPublishing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const media = useMediaAttachments();

  React.useEffect(() => {
    ref.current?.focus();
  }, []);

  const autoGrow = React.useCallback(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const charCount = media.totalCharCount(content);
  const hasImage = media.attachments.some((a) => a.type === "image");
  const isOver = charCount > REPLY_CHAR_LIMIT;
  const canPost =
    (content.trim().length > 0 || hasImage) && !isOver && !publishing;

  async function handleSubmit() {
    if (!canPost) return;
    setPublishing(true);
    setError(null);
    try {
      await publishReply({
        content: media.buildContent(content),
        targetEventId: target.eventId,
        targetKind: target.eventKind,
        targetAuthorPubkey: target.authorPubkey,
        parentCommentId: target.parentCommentId,
        parentCommentEventId: target.parentCommentEventId,
      });
      media.reset();
      onPublished?.();
      onClose();
    } catch (err) {
      setError(failureSentence(err, "Couldn’t send your reply. It’s still in the box, so please try again."));
      setPublishing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && !publishing) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  const remaining = REPLY_CHAR_LIMIT - charCount;
  const displayError = error ?? media.error;
  // The image control appears once there is something to attach it to: at rest
  // this is a text field and nothing else.
  const expanded = content.length > 0 || media.attachments.length > 0;

  return (
    <InlineReplyPanel
      palette={palette}
      label={`Replying to ${target.authorName || "this post"}`}
      onClose={onClose}
    >
      <textarea
        ref={ref}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          media.detectEmbeds(e.target.value);
          autoGrow();
        }}
        onKeyDown={handleKeyDown}
        placeholder="Write a reply…"
        rows={2}
        className="w-full px-3 py-2 text-ui-sm resize-none outline-none bg-transparent"
        style={{ color: palette.cardTitle, caretColor: palette.cardTitle }}
        disabled={publishing}
      />

      <div className="px-3">
        <MediaPreview
          attachments={media.attachments}
          onRemove={media.removeAttachment}
          uploading={media.uploading}
        />
      </div>

      <div className="px-3 pb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {expanded && (
            <button
              type="button"
              onClick={media.triggerImageUpload}
              disabled={media.uploading}
              className="transition-opacity hover:opacity-70 disabled:opacity-40"
              style={{ color: palette.cardMeta }}
              title="Add image"
              aria-label="Add image"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                <circle cx="5.5" cy="5.5" r="1" />
                <path d="M14.5 10.5L11 7L3.5 14.5" />
              </svg>
            </button>
          )}
          {displayError && (
            <span
              className="text-ui-xs truncate"
              style={{ color: "var(--ah-crimson)" }}
            >
              {displayError}
            </span>
          )}
          {remaining <= 200 && (
            <span
              className="label-ui"
              style={{
                color: isOver ? "var(--ah-crimson)" : "var(--ah-grey-400)",
              }}
            >
              {remaining}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canPost}
          className="label-ui px-3 py-1 rounded disabled:opacity-40"
          style={{ background: "var(--ah-ink)", color: "var(--ah-white)" }}
        >
          {publishing ? "Sending…" : "Reply"}
        </button>
      </div>
    </InlineReplyPanel>
  );
}
