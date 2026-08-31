"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../../stores/auth";
import { useCompose } from "../../stores/compose";
import {
  publishNote,
  type QuoteTarget,
  type CrossPostTarget,
} from "../../lib/publishNote";
import { useMediaAttachments } from "../../hooks/useMediaAttachments";
import { useLinkedAccounts } from "../../hooks/useLinkedAccounts";
import { MediaPreview } from "../ui/MediaPreview";
import type { LinkedAccount } from "../../lib/api";
import { Glasshouse } from "../workspace/Glasshouse";
import { useEditorOverlay, seedFromNote } from "../../stores/editorOverlay";

const NOTE_CHAR_LIMIT = 1000;

export function ComposeOverlay() {
  const { user } = useAuth();
  const { isOpen, mode, replyTarget, close, onPublished } = useCompose();
  const [content, setContent] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [crossPostIds, setCrossPostIds] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLTextAreaElement>(null);
  const media = useMediaAttachments();
  const linkedAccounts = useLinkedAccounts();

  // Focus textarea on open; reset state when closed.
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => ref.current?.focus(), 10);
    } else {
      setContent("");
      setPublishing(false);
      setError(null);
      setConfirmDismiss(false);
      setCrossPostIds(new Set());
      media.reset();
    }
  }, [isOpen]);

  const hasContent =
    content.trim().length > 0 ||
    media.attachments.filter((a) => a.type === "image").length > 0;

  // Single close path, wired to Glasshouse's scrim / ✕ / Escape. Note/reply uses
  // a two-step confirm when dirty. (Articles are written in the EditorOverlay.)
  const dismiss = useCallback(() => {
    if (hasContent && !confirmDismiss) {
      setConfirmDismiss(true);
      return;
    }
    setConfirmDismiss(false);
    close();
  }, [hasContent, confirmDismiss, close]);

  const charCount = media.totalCharCount(content);
  const isOver = charCount > NOTE_CHAR_LIMIT;
  const isEmpty = !hasContent;
  const canPost = !isEmpty && !isOver && !publishing;

  const handlePost = useCallback(async () => {
    if (!canPost || !user) return;
    setPublishing(true);
    setError(null);
    try {
      const finalContent = media.buildContent(content);
      const crossPosts: CrossPostTarget[] = Array.from(crossPostIds).map(
        (id) => ({ linkedAccountId: id, actionType: "original" as const }),
      );
      const result = await publishNote(
        finalContent,
        user.pubkey,
        replyTarget ?? undefined,
        crossPosts.length > 0 ? crossPosts : undefined,
      );
      onPublished?.({
        type: "note",
        id: result.noteEventId,
        pubkey: user.pubkey,
        content: finalContent,
        publishedAt: Math.floor(Date.now() / 1000),
        quotedEventId: replyTarget?.eventId,
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post.");
    } finally {
      setPublishing(false);
    }
  }, [
    canPost,
    user,
    content,
    media,
    replyTarget,
    crossPostIds,
    onPublished,
    close,
  ]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setContent(val);
    setConfirmDismiss(false);
    media.detectEmbeds(val);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handlePost();
    }
  }

  function toggleCrossPost(accountId: string) {
    setCrossPostIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  if (!isOpen || !user) return null;

  const displayError = error ?? media.error;
  const validAccounts = (linkedAccounts ?? []).filter((a) => a.isValid);

  return (
    <Glasshouse
      onClose={dismiss}
      maxWidth={640}
      ariaLabel={mode === "reply" ? "Compose reply" : "Compose note"}
    >
      {/* Bounded-height column so the body scrolls internally rather than the
          whole pane growing past the viewport — sized against the pane's
          --gh-h (the on-screen height below the dragged position), not a
          fixed viewport calc, so dragging the pane down can't clip the
          controls zone. Separation is whitespace — no internal rules
          (sitewide no-thin-line rule). */}
      <div className="flex flex-col max-h-[var(--gh-h)]">
        {/* Top zone — pr-12 keeps content clear of the floating ✕. */}
        <div className="px-6 pt-5 pb-3 pr-12">
          {mode === "reply" && replyTarget ? (
            <ReplyPreview target={replyTarget} onClear={() => close()} />
          ) : (
            <span className="label-ui text-grey-600">NOTE</span>
          )}
        </div>

        {/* Editing zone */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          <textarea
            ref={ref}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "reply"
                ? "Add your thoughts..."
                : "What's on your mind?"
            }
            rows={4}
            className="w-full resize-none bg-glasshouse-well px-4 py-3 font-sans text-[16px] text-black placeholder:text-grey-400 focus:outline-none leading-[1.6] border-none"
          />
          <MediaPreview
            attachments={media.attachments}
            onRemove={media.removeAttachment}
            uploading={media.uploading}
          />
        </div>

        {/* Controls zone */}
        <div className="px-6 py-3 flex items-center gap-4">
          {/* Image upload */}
          <button
            onClick={media.triggerImageUpload}
            disabled={media.uploading}
            className="text-grey-600 hover:text-black disabled:opacity-40 transition-colors"
            title="Add image"
          >
            <svg
              width="18"
              height="18"
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

          {/* Cross-post toggle */}
          {validAccounts.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="label-ui text-grey-400">ALSO POST TO:</span>
              {validAccounts.map((account) => (
                <CrossPostPill
                  key={account.id}
                  account={account}
                  active={crossPostIds.has(account.id)}
                  onToggle={() => toggleCrossPost(account.id)}
                />
              ))}
            </div>
          )}

          <span className="flex-1" />

          {/* Character counter */}
          {charCount > 0 && (
            <span
              className={`font-mono text-mono-xs transition-colors ${isOver ? "text-crimson font-medium" : charCount > NOTE_CHAR_LIMIT - 50 ? "text-crimson" : "text-grey-600"}`}
            >
              {charCount}/{NOTE_CHAR_LIMIT}
            </span>
          )}

          {/* Mode switch: escalate a note-in-progress into the article editor */}
          {mode === "note" && (
            <button
              type="button"
              onClick={() => {
                const seed = seedFromNote(content);
                useEditorOverlay.getState().open(seed);
                close();
              }}
              className="label-ui text-grey-600 hover:text-black transition-colors"
            >
              Make this an article &rarr;
            </button>
          )}

          {/* Post button */}
          <button
            onClick={handlePost}
            disabled={!canPost}
            className="btn disabled:opacity-30 py-1.5 px-5 text-[12px] font-sans font-semibold"
          >
            {publishing ? "Posting…" : "Post"}
          </button>
        </div>

        {/* Error / confirm dismiss */}
        {(displayError || confirmDismiss) && (
          <div className="px-6 pb-3">
            {confirmDismiss && (
              <p className="text-ui-sm text-grey-600">
                Discard this? Press Escape or click away again to confirm.
              </p>
            )}
            {displayError && (
              <div className="flex items-center justify-between">
                <p className="text-ui-xs text-crimson">{displayError}</p>
                <button
                  onClick={() => {
                    setError(null);
                    media.clearError();
                  }}
                  className="text-grey-600 hover:text-crimson text-sm ml-2"
                >
                  &times;
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Glasshouse>
  );
}

// ─── Reply preview ─────────────────────────────────────────────────────────

function ReplyPreview({
  target,
  onClear,
}: {
  target: QuoteTarget;
  onClear: () => void;
}) {
  return (
    <div
      className="flex items-start gap-2"
      style={{ borderLeft: "4px solid var(--ah-crimson)", paddingLeft: "16px" }}
    >
      <div className="flex-1 min-w-0">
        {target.highlightedText ? (
          <>
            <p className="font-serif italic text-[14px] text-grey-600 leading-[1.5] line-clamp-3">
              {target.highlightedText
                .trim()
                .split(/\s+/)
                .slice(0, 80)
                .join(" ")}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-grey-600 mt-1">
              {target.previewTitle && <span>{target.previewTitle}</span>}
              {target.previewTitle && target.previewAuthorName && " — "}
              {target.previewAuthorName}
            </p>
          </>
        ) : (
          <>
            <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-grey-400">
              {target.previewAuthorName ??
                target.authorPubkey.slice(0, 10) + "…"}
            </p>
            {target.previewTitle && (
              <p className="text-ui-xs font-sans font-medium text-black leading-snug mt-0.5 line-clamp-1">
                {target.previewTitle}
              </p>
            )}
            {target.previewContent ? (
              <p className="text-[12px] font-sans text-grey-600 leading-relaxed line-clamp-2 mt-0.5">
                {target.previewContent}
              </p>
            ) : (
              <p className="text-[12px] font-sans text-grey-600 italic mt-0.5">
                Note
              </p>
            )}
          </>
        )}
      </div>
      <button
        onClick={onClear}
        className="text-grey-600 hover:text-grey-400 text-sm transition-colors flex-shrink-0"
        title="Remove"
      >
        &times;
      </button>
    </div>
  );
}

// ─── Cross-post pill ───────────────────────────────────────────────────────

const PROTOCOL_NAMES: Record<string, string> = {
  activitypub: "MASTODON",
  atproto: "BLUESKY",
  nostr_external: "NOSTR",
};

function CrossPostPill({
  account,
  active,
  onToggle,
}: {
  account: LinkedAccount;
  active: boolean;
  onToggle: () => void;
}) {
  const label =
    PROTOCOL_NAMES[account.protocol] ?? account.protocol.toUpperCase();
  return (
    <button
      onClick={onToggle}
      className={`label-ui px-2 py-0.5 transition-colors ${
        active
          ? "bg-black text-white"
          : "bg-grey-100 text-grey-400 hover:text-grey-600"
      }`}
    >
      {label}
    </button>
  );
}
