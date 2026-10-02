'use client'

import type { QuoteTarget } from '../../lib/publishNote'
import type { NoteEvent } from '../../lib/ndk'
import { Glasshouse } from './Glasshouse'
import { MediaPreview } from '../ui/MediaPreview'
import { CrossPostPill } from '../compose/CrossPostPill'
import { AttachImageButton } from '../compose/AttachImageButton'
import { useNoteComposer, NOTE_CHAR_LIMIT } from '../../hooks/useNoteComposer'
import { NOTE_TOO_LONG_READER } from '../../content/writer-access'
import { networkName } from '../../content/conversation'

// Every colour here is in the INVERTING family (`ink`/`white`/`bone`/greys).
// This panel is mounted at the WorkspaceView root with NO light island above
// it, so its ground resolves through the `html.dark` inversion — and a
// never-inverting foreground on top of one (`ink-925` on `white` = 26 26 24 on
// 30 29 26, a contrast ratio of 1.03:1) is invisible. Foreground and ground
// must be in the SAME inversion family; see `.claude/rules/web-theme.md` ›
// Global light/dark mode.
const TOKENS = {
  panelBorder: 'var(--ah-ink)',
  bannerBg: 'var(--ah-bone)',
  bannerFg: 'var(--ah-ink)',
  hintFg: 'var(--ah-grey-600)',
  errorFg: 'var(--ah-crimson)',
  publishBg: 'var(--ah-ink)',
  publishFg: 'var(--ah-bone)',
  publishDisabled: 'var(--ah-grey-300)',
  // Inset well a touch darker than the now-white Glasshouse pane (bg-glasshouse).
  fieldBg: 'var(--ah-glasshouse-well)',
}

interface ComposerProps {
  open: boolean
  // When set, the note is published as a NIP-18 quote embedding this target.
  quoteTarget?: QuoteTarget | null
  onClose: () => void
  /** A supersede: the host drops `open` and KEEPS the quote target, so the
   *  draft comes back as what it was written as. */
  onSuspend: () => void
  onPublished?: (note: NoteEvent) => void
}

// The workspace's note/quote composer. Its BEHAVIOUR is `useNoteComposer`,
// shared with the global `ComposeOverlay` — the two compose surfaces are one
// rule (web/CLAUDE.md › *Compose surfaces*), so everything but the
// presentation lives in the hook. Article writing is the global EditorOverlay;
// "Make this an article" and the over-limit banner open it, seeded with the
// note body and its pictures.
export function Composer({ open, quoteTarget, onClose, onSuspend, onPublished }: ComposerProps) {
  const c = useNoteComposer({
    open,
    quoteTarget: quoteTarget ?? null,
    close: onClose,
    onPublished,
  })

  if (!open) return null

  const { media, charCount, isOver, displayError, isQuote } = c

  return (
    <Glasshouse
      onClose={c.dismiss}
      // A SUPERSEDE IS NOT A DISCARD, and this prop used to make it one. The
      // escalation IS a handover — the body travels into the editor, so
      // neither the publishing guard nor any confirm applies — but it is one
      // superseder out of many, and every ∀-menu destination took an unsent
      // note away in a click with nothing said. Refusing to close is not the
      // alternative (two live Glasshouses, the state `21bb0bfe` replaced), so
      // the draft survives the supersede and comes back on reopen.
      // The host SUSPENDS rather than closes, keeping the quote target — its
      // close clears it, and a superseded quote used to come back as a note.
      onSupersede={() => c.onSupersede(onSuspend)}
      maxWidth={640}
      ariaLabel={isQuote ? 'Quote' : 'New note'}
      persistKey="composer"
      resizable
      // THE THIRD IMMERSIVE PANE. Writing is writing at either length: the note
      // composer takes `coverNavChrome` exactly as the reader and the article
      // editor do, and `WorkspaceView` un-mounts the bar + muster while it is
      // open. Without it a 640 box hung under a live muster — twenty black
      // roundels, the loudest thing on screen, over the one surface that is
      // meant to be a blank page. No `fillHeight`: a note is short, so the pane
      // stays content-sized (and stretchable) rather than claiming the window.
      coverNavChrome
    >
      {/* Flex column that fills the pane: when the pane is content-sized (default)
          `h-full` resolves to auto so the textarea stays compact; when the pane is
          stretched it resolves to the explicit height, giving the flex-1 textarea
          free space to fill. The scroll region is the OUTER box, so the scrollbar
          stays at the pane's edge however narrow the column inside it gets. */}
      <div
        className="flex flex-col h-full max-h-[var(--gh-h)] overflow-y-auto"
        style={{ padding: 24 }}
        // Explain base kind (C2): answers any interior hover a more specific
        // leaf doesn't; the pane chrome stays with the generic `pane` tag.
        data-explain="composer"
      >
        {/* THE MEASURE COLUMN. The textarea was `w-full`, so stretching the pane
            to 1400 gave the note a ~180-character line — every pixel of the
            stretch spent on the one thing that gets worse the more of it you
            have. It now caps at `.ah-measure`: unchanged at rest (the pane opens
            at 640, so the field is parent-limited well under the cap), then
            easing wider on the pane's curve (lib/workspace/measure.ts).

            The cap is on the COLUMN and not on the textarea alone, or the field
            would narrow and centre while the reply banner, the nudge and the
            publish row stayed full-width beside it — a lopsided pane. Capping the
            lot makes the extra width air on both sides, which is exactly what the
            article editor does with its document column; the two writers answer a
            stretch the same way because they are the same act at two lengths.

            Height is untouched and stays linear: more lines is always worth
            having, so the textarea keeps `flex-1` and the column passes the
            pane's height straight through (`flex-1 … min-h-0`). */}
        <div className="ah-measure w-full mx-auto flex-1 flex flex-col min-h-0">
          {/* Mode label — also reserves top-right clearance for the Glasshouse ✕. */}
          <div
            className="label-ui"
            style={{ color: TOKENS.hintFg, marginBottom: 16, paddingRight: 32 }}
          >
            {isQuote ? 'QUOTE' : 'NOTE'}
          </div>
          {isQuote && quoteTarget && (
            <div
              style={{
                background: TOKENS.bannerBg,
                padding: '10px 12px',
                marginBottom: 16,
                borderLeft: `4px solid ${TOKENS.panelBorder}`,
              }}
            >
              <div className="label-ui" style={{ color: TOKENS.hintFg }}>
                Quoting{' '}
                {quoteTarget.previewAuthorName ??
                  (quoteTarget.authorPubkey
                    ? `${quoteTarget.authorPubkey.slice(0, 10)}…`
                    : (quoteTarget.quotedSource ?? 'a post'))}
              </div>
              {quoteTarget.previewTitle && (
                <p
                  className="font-sans text-ui-xs mt-1"
                  style={{ color: TOKENS.bannerFg, fontWeight: 500 }}
                >
                  {quoteTarget.previewTitle}
                </p>
              )}
              {quoteTarget.previewContent && (
                // Clamped for the BANNER only. previewContent is the snapshot that
                // gets stored (quotePreviewContent — a whole note, up to 1000
                // chars), which is right for the inset a reader later expands and
                // far too much for a strip above the textarea.
                <p
                  className="font-serif italic text-[13px] mt-1 line-clamp-3"
                  style={{ color: TOKENS.bannerFg, lineHeight: 1.45 }}
                >
                  {quoteTarget.previewContent}
                </p>
              )}
            </div>
          )}

          <textarea
            ref={c.textareaRef}
            value={c.content}
            onChange={c.handleChange}
            onKeyDown={c.handleKeyDown}
            placeholder="What’s on your mind?"
            className="font-serif text-[16px] w-full flex-1"
            style={{
              background: TOKENS.fieldBg,
              padding: '12px 14px',
              minHeight: 160,
              resize: 'none',
              outline: 'none',
              lineHeight: 1.55,
              marginTop: 16,
            }}
          />
          <MediaPreview
            attachments={media.attachments}
            onRemove={media.removeAttachment}
            uploading={media.uploading}
          />
          {/* The prompted half of the escalation — the standing button below is
              the quiet half. Same band, same copy and the same two text actions
              as the global `ComposeOverlay`: the two compose surfaces are one
              rule (web/CLAUDE.md › *Compose surfaces*), so a prompt added to
              one is owed to the other in the same construction, not merely at
              the same moment. */}
          {c.showNudge && (
            <div
              className="bg-glasshouse-well flex items-center justify-between gap-4"
              style={{ marginTop: 8, padding: '12px 16px' }}
            >
              <span className="text-ui-xs" style={{ color: TOKENS.bannerFg }}>
                This is over the {NOTE_CHAR_LIMIT.toLocaleString('en-GB')}-character limit for notes. Would you like to turn it into an article?
              </span>
              <span className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={c.escalateToArticle}
                  className="btn-text"
                  data-explain="composer.article"
                >
                  Make it an article
                </button>
                <button type="button" onClick={c.dismissNudge} className="btn-text-muted">
                  Dismiss
                </button>
              </span>
            </div>
          )}
          {/* The standing offer — withdrawn while the banner is up, because the
              banner IS the offer at that moment and two controls carrying the
              same action, stacked, is furniture arguing with itself. */}
          {c.showTooLong && (
            <div
              className="bg-glasshouse-well"
              style={{ marginTop: 8, padding: '12px 16px' }}
            >
              <span className="text-ui-xs" style={{ color: TOKENS.bannerFg }}>
                {NOTE_TOO_LONG_READER}
              </span>
            </div>
          )}
          {c.canEscalate && !c.showNudge && (
            <div style={{ marginTop: 8, textAlign: 'right' }}>
              <button
                type="button"
                onClick={c.escalateToArticle}
                className="font-sans text-ui-xs"
                data-explain="composer.article"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: TOKENS.hintFg,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Make this an article →
              </button>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 12,
              gap: 16,
            }}
          >
            <div className="flex items-center gap-4 min-w-0">
              <AttachImageButton onClick={media.triggerImageUpload} disabled={media.uploading} />
              <span
                className="font-mono text-mono-xs"
                style={{ color: isOver ? TOKENS.errorFg : TOKENS.hintFg }}
              >
                {c.activeCrossPosts.length > 0 && (
                  <>
                    Also posting to{' '}
                    {c.activeCrossPosts
                      .map((a) => networkName(a.protocol) ?? a.protocol)
                      .join(' · ')}{' '}
                    —{' '}
                  </>
                )}
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {/* Per-send cross-post pills — one per valid linked network that
                  can receive an original post, resting on the account's own
                  default. A quote carries none. An outage is said out loud:
                  silence would read as "linked nothing". */}
              {c.linkedAccountsFailed && (
                <span className="label-ui" style={{ color: TOKENS.hintFg }}>
                  Couldn&rsquo;t check your linked accounts, so this will only go to all.haus
                </span>
              )}
              {c.crossPostAccounts.map((account) => (
                <CrossPostPill
                  key={account.id}
                  account={account}
                  active={c.isCrossPostOn(account)}
                  onToggle={() => c.toggleCrossPost(account)}
                />
              ))}
              <button
                type="button"
                onClick={c.handlePost}
                disabled={!c.canPost}
                title={isQuote ? 'Quote (Ctrl+Enter)' : 'Post (Ctrl+Enter)'}
                className="font-sans text-ui-xs"
                style={{
                  padding: '8px 16px',
                  background: c.canPost ? TOKENS.publishBg : TOKENS.publishDisabled,
                  color: TOKENS.publishFg,
                  border: 'none',
                  cursor: c.canPost ? 'pointer' : 'default',
                }}
              >
                {c.publishing
                  ? isQuote
                    ? 'Quoting…'
                    : 'Posting…'
                  : isQuote
                    ? 'Quote'
                    : 'Post'}
              </button>
            </div>
          </div>

          {/* Error / confirm dismiss — the same two lines as the overlay. */}
          {(displayError || c.confirmDismiss) && (
            <div style={{ marginTop: 12 }}>
              {c.confirmDismiss && (
                <p className="text-ui-sm" style={{ color: TOKENS.hintFg }}>
                  Discard this? Press Escape or click away again to confirm.
                </p>
              )}
              {displayError && (
                <div className="flex items-center justify-between">
                  <p className="text-ui-xs" style={{ color: TOKENS.errorFg }}>
                    {displayError}
                  </p>
                  <button
                    type="button"
                    onClick={c.clearError}
                    aria-label="Dismiss error"
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
  )
}
