"use client";

import { useAuth } from "../../stores/auth";
import { useCompose } from "../../stores/compose";
import type { QuoteTarget } from "../../lib/publishNote";
import { MediaPreview } from "../ui/MediaPreview";
import { CrossPostPill } from "./CrossPostPill";
import { AttachImageButton } from "./AttachImageButton";
import { Glasshouse } from "../workspace/Glasshouse";
import { NOTE_TOO_LONG_READER } from "../../content/writer-access";
import {
  useNoteComposer,
  NOTE_CHAR_LIMIT,
} from "../../hooks/useNoteComposer";

// The global short-form composer, off the workspace. Its BEHAVIOUR is
// `useNoteComposer`, shared with the workspace `Composer` — the two compose
// surfaces are one rule (web/CLAUDE.md › *Compose surfaces*), so everything
// but the presentation lives in the hook.
export function ComposeOverlay() {
  const { user } = useAuth();
  const { isOpen, mode, quoteTarget, close, suspend } = useCompose();
  const c = useNoteComposer({
    open: isOpen,
    // THE DISCRIMINATOR IS THE MODE, NEVER "WHICHEVER TARGET WE HAPPEN TO
    // HAVE". `publishNote`'s third argument writes a NIP-18 `q` tag and indexes
    // the note as `isQuoteComment`, and this surface once handed it a REPLY
    // target, so every "Reply" published a quote. Replies have since left this
    // surface altogether (they are written in the card's own footer); what
    // survives from that fault is the rule that a publisher is chosen by the
    // mode and by nothing else.
    quoteTarget: mode === "quote" ? quoteTarget : null,
    close,
  });

  if (!isOpen || !user) return null;

  const { media, charCount, isOver, displayError } = c;

  return (
    <Glasshouse
      onClose={c.dismiss}
      // A SUPERSEDE IS NOT A DISCARD, and it used to be one. The comment here
      // assumed the only superseder was the article editor — which IS a
      // handover, because the body travels into it — but every ∀-menu
      // destination supersedes this pane too, and each of those took an
      // unsent note away in one click with no confirm and nothing said.
      // A dirty-confirm cannot be the answer: refusing to close would leave
      // two Glasshouses live, which is what the pre-`21bb0bfe` `dismiss`
      // fallback did and is worse. So the draft SURVIVES instead, which
      // removes the loss rather than warning about it.
      // (`suspend` keeps the store's mode and target, so an unsent QUOTE
      // comes back as a quote rather than turning into a note.)
      onSupersede={() => c.onSupersede(suspend)}
      maxWidth={640}
      ariaLabel={mode === "quote" ? "Compose quote" : "Compose note"}
      // The third immersive pane, exactly as the workspace `Composer` is:
      // writing is writing at either length. `LayoutShell` un-mounts
      // `PublicNavBar` while this is open (it keeps the band RESERVED, so the
      // page underneath doesn't reflow behind the frost). No `fillHeight` — a
      // note is short, and the pane stays content-sized.
      coverNavChrome
    >
      {/* Bounded-height column so the body scrolls internally rather than the
          whole pane growing past the viewport — sized against the pane's
          --gh-h (the on-screen height below the dragged position), not a
          fixed viewport calc, so dragging the pane down can't clip the
          controls zone. Separation is whitespace — no internal rules
          (sitewide no-thin-line rule). */}
      <div className="flex flex-col max-h-[var(--gh-h)]">
        {/* THE MEASURE COLUMN, matching the workspace `Composer`. This pane is
            not `resizable` today, so `--ah-measure` is always the rest measure
            here and the cap never bites (the pane opens at 640 and the zones'
            own px-6 leaves 592). It is here anyway because the two compose
            surfaces are one rule — web/CLAUDE.md › *Compose surfaces* — and the
            day a stretch handle is added to this one, the alternative is the
            180-character line the other one had, found by somebody else. */}
        <div className="ah-measure w-full mx-auto flex flex-col min-h-0">
          {/* Top zone — pr-12 keeps content clear of the floating ✕. */}
          <div className="px-6 pt-5 pb-3 pr-12">
            {mode === "quote" && quoteTarget ? (
              <QuotePreview target={quoteTarget} />
            ) : (
              <span className="label-ui text-grey-600">NOTE</span>
            )}
          </div>

          {/* Editing zone */}
          <div className="flex-1 overflow-y-auto px-6 pb-4">
            <textarea
              ref={c.textareaRef}
              value={c.content}
              onChange={c.handleChange}
              onKeyDown={c.handleKeyDown}
              placeholder={
                mode === "note" ? "What’s on your mind?" : "Add your thoughts…"
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

          {/* THE OFFER ARRIVES WHERE THE WALL IS — the prompted half of the
              escalation, the standing text button below being the quiet half.
              The workspace `Composer` carries the same banner at the same
              moment: the two compose surfaces are one rule (web/CLAUDE.md ›
              *Compose surfaces*), so a prompt added to one is owed to the
              other. Over the limit is the only moment worth interrupting for —
              Post has just gone dead and the note cannot become shorter without
              becoming something else. Dismissible per opening. */}
          {c.showNudge && (
            <div className="mx-6 mb-2 px-4 py-3 bg-glasshouse-well flex items-center justify-between gap-4">
              <span className="text-ui-xs text-black">
                This is over the {NOTE_CHAR_LIMIT.toLocaleString("en-GB")}-character limit for notes. Would you like to turn it into an article?
              </span>
              <span className="flex items-center gap-4">
                <button type="button" onClick={c.escalateToArticle} className="btn-text">
                  Make it an article
                </button>
                <button
                  type="button"
                  onClick={c.dismissNudge}
                  className="btn-text-muted"
                >
                  Dismiss
                </button>
              </span>
            </div>
          )}

          {c.showTooLong && (
            <div className="mx-6 mb-2 px-4 py-3 bg-glasshouse-well">
              <span className="text-ui-xs text-black">{NOTE_TOO_LONG_READER}</span>
            </div>
          )}

          {/* Controls zone */}
          <div className="px-6 py-3 flex items-center gap-4">
            <AttachImageButton
              onClick={media.triggerImageUpload}
              disabled={media.uploading}
            />

            {/* Cross-posting is the plain NOTE's alone (a quote carries no
                crossPosts), and only to networks that can receive an original
                post — the hook hands back none for a quote. An outage is said
                out loud rather than read as "linked nothing". */}
            {c.linkedAccountsFailed && (
              <span className="label-ui text-grey-600">
                Couldn&rsquo;t check your linked accounts, so this will only go to all.haus
              </span>
            )}
            {c.crossPostAccounts.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="label-ui text-grey-400">ALSO POST TO:</span>
                {c.crossPostAccounts.map((account) => (
                  <CrossPostPill
                    key={account.id}
                    account={account}
                    active={c.isCrossPostOn(account)}
                    onToggle={() => c.toggleCrossPost(account)}
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

            {/* The standing offer — the quiet half of the escalation
                (`escalateToArticle`), withdrawn while the banner above is up:
                the banner IS the offer at that moment, and two controls
                carrying the same action is furniture arguing with itself. */}
            {c.canEscalate && !c.showNudge && (
              <button
                type="button"
                onClick={c.escalateToArticle}
                className="label-ui text-grey-600 hover:text-black transition-colors"
              >
                Make this an article &rarr;
              </button>
            )}

            {/* Post button */}
            <button
              onClick={c.handlePost}
              disabled={!c.canPost}
              title="Post (Ctrl+Enter)"
              className="btn disabled:opacity-30 py-1.5 px-5 text-[12px] font-sans font-semibold"
            >
              {c.publishing ? "Posting…" : "Post"}
            </button>
          </div>

          {/* Error / confirm dismiss */}
          {(displayError || c.confirmDismiss) && (
            <div className="px-6 pb-3">
              {c.confirmDismiss && (
                <p className="text-ui-sm text-grey-600">
                  Discard this? Press Escape or click away again to confirm.
                </p>
              )}
              {displayError && (
                <div className="flex items-center justify-between">
                  <p className="text-ui-xs text-crimson">{displayError}</p>
                  <button
                    onClick={c.clearError}
                    className="text-grey-600 hover:text-crimson text-sm ml-2"
                  >
                    &times;
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Glasshouse>
  );
}

// ─── Quote preview ─────────────────────────────────────────────────────────

function QuotePreview({ target }: { target: QuoteTarget }) {
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
    </div>
  );
}
