"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  workspaceFeeds as workspaceFeedsApi,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
  type FollowImportProtocol,
  type FeedImportBinding,
} from "../../lib/api";
import { apiErrorMessage, failureSentence } from "../../lib/api/client";
import { useEscapeShield } from "../../hooks/useEscapeShield";
import { useResolverInput } from "../../hooks/useResolverInput";
import { reportFollowState } from "../../hooks/useFeedFollow";
import type { MatchOption } from "../../lib/workspace/resolve";
import { getNetworkCapabilities } from "../../lib/api/linked-accounts";
import { useFollowImportRun } from "../../hooks/useFollowImportRun";
import { FollowImportStatus } from "../network/FollowImportStatus";
import { FeedSyncSection } from "./FeedSyncSection";
import { FeedFormulaSection } from "./FeedFormulaSection";
import { formulasAvailable } from "../../lib/api/formulas";
import {
  FEED_ADD_NAME,
  FEED_ADD_SOURCE_LABEL,
  FEED_CANCEL,
  FEED_COMPOSER_TITLE,
  FEED_DELETE,
  FEED_DELETE_BLOCKED,
  FEED_DELETE_CONFIRM,
  FEED_DELETE_FEED,
  FEED_DELETING,
  FEED_ERROR_ADD_SOURCE,
  FEED_ERROR_DELETE,
  FEED_ERROR_LOAD_SOURCES,
  FEED_ERROR_MOVE_SOURCE,
  FEED_ERROR_REMOVE_SOURCE,
  FEED_ERROR_RENAME,
  FEED_HIDE,
  FEED_IMPORT_FOLLOWS,
  FEED_MERGE_INTO_PICK,
  FEED_NAME_PLACEHOLDER,
  FEED_NAME_SAVE,
  FEED_NAME_SAVING,
  FEED_NO_NAME,
  FEED_RENAME,
  FEED_RESOLVER_MATCHES,
  FEED_RESOLVER_NO_MATCH,
  FEED_RESOLVER_PLACEHOLDER,
  FEED_RESOLVER_SUGGESTIONS,
  FEED_SHARE_LINK_WILL_STOP,
  FEED_SOURCES_EMPTY,
  FEED_SOURCES_LABEL,
  FEED_SOURCE_MOVE,
  FEED_SOURCE_MOVE_TO,
  FEED_SOURCE_MUTE,
  FEED_SOURCE_NO_REPLIES,
  FEED_SOURCE_NO_REPLIES_TITLE,
  FEED_SOURCE_NO_SIGNAL_TITLE,
  FEED_SOURCE_SAMPLING_LABEL,
  FEED_SOURCE_SAMPLING_RECENT,
  FEED_UNHIDE,
  FEED_UNNAMED,
  feedNameTooLong,
  feedSourceMoveTo,
  feedSourceRemove,
  feedSourceVolume,
} from "../../content/feed-settings";
import { AnchoredPopover } from "../ui/AnchoredPopover";
import { Pointer } from "../ui/Pointer";
import { Glasshouse } from "./Glasshouse";
import { AuthorModal, useAuthorHover } from "../feed/AuthorModal";
import { openProfileHref, isModifiedClick } from "../ui/ProfileLink";
import { openSurfaceHref } from "../../stores/surfaceOverlay";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";
import { useColorScheme } from "../../stores/colorScheme";
import {
  type FeedScheme,
  type Density,
  type TextSize,
  nextDensity,
  nextTextSize,
  normalizeBrightness,
  normalizeDensity,
  paletteFor,
  SCHEME_OPTIONS,
  DEFAULT_TEXT_SIZE,
} from "./tokens";
import {
  VOLUME_THROUGHPUT,
  throughputToStep,
  stepPercent,
} from "../../lib/volume-scale";

// The composer is an always-light Glasshouse surface (warm mid-light pane, dark
// text), so these are fixed tokens, not a brightness palette. Separation is fill
// + space — no borders anywhere (the site never renders thin rules). Fields read
// as bright (white) raised wells on the pane; rows are a lighter tile; emphasis
// is a dark fill.
// Every colour here is in the INVERTING family (`ink`/`white`/`bone`/greys).
// This panel is mounted at the WorkspaceView root with NO light island above
// it, so its ground resolves through the `html.dark` inversion — and a
// never-inverting foreground on top of one (`ink-925` on `white` = 26 26 24 on
// 30 29 26, a contrast ratio of 1.03:1) is invisible. Foreground and ground
// must be in the SAME inversion family; see `.claude/rules/web-theme.md` ›
// Global light/dark mode.
const TOKENS = {
  panelBorder: "var(--ah-ink)",
  rowBg: "var(--ah-bone)",
  fieldBg: "var(--ah-white)",
  hintFg: "var(--ah-grey-600)",
  errorFg: "var(--ah-crimson)",
  matchHoverBg: "var(--ah-bone)",
  removeFg: "var(--ah-grey-600)",
  removeHoverFg: "var(--ah-crimson)",
  // The hover author-card portals above the Glasshouse pane (z-56); 70 also
  // clears the ForallMenu (z-60) so the transient card is never clipped.
  hoverZ: 70,
};

interface FeedComposerProps {
  feed: WorkspaceFeed | null;
  open: boolean;
  onClose: () => void;
  onSourcesChanged?: () => void;
  onRenamed?: (feed: WorkspaceFeed) => void;
  onDeleted?: (feedId: string) => void;
  /** When true, the composer refuses to delete this feed and surfaces a hint
   *  explaining why. Used to prevent the user from deleting their last feed
   *  (which would leave the floor empty until next bootstrap reseeds). */
  deleteBlocked?: boolean;
  // Appearance controls (moved off the vessel bar — task 8). Current values +
  // commit callbacks, wired from WorkspaceView against the workspace store
  // (and, for scheme, the server-side feeds.appearance — feature-debt §3).
  scheme?: FeedScheme;
  density?: Density;
  textSize?: TextSize;
  onSchemeChange?: (s: FeedScheme) => void;
  onDensityChange?: (d: Density) => void;
  onTextSizeChange?: (t: TextSize) => void;
  // Drag-to-rank (MOBILE-LAYOUT-ADR §VII.4): the caller's complete feed set
  // and a commit callback. The rank order is the numeral and the mobile swipe
  // order; the list shows every feed (hidden ones unnumbered, per §V).
  allFeeds?: WorkspaceFeed[];
  onReorder?: (feedIds: string[]) => void;
  // Hide toggle (MOBILE-LAYOUT-ADR §V): hide is feed character on the feed
  // row. On mobile this sheet is the only hide affordance (no vessel bar);
  // on desktop it complements the vessel bar's hide button.
  hidden?: boolean;
  onHiddenChange?: (hidden: boolean) => void;
  // Merge, rehomed from the floor's vessel-on-vessel drop
  // (WORKSPACE-QUEUE-ADR §XI.2 R1). The panel only CHOOSES the target; the
  // caller asks the question (MergeFeedConfirm) and owns the write.
  onMergeInto?: (target: WorkspaceFeed) => void;
  // A source moved out of this feed by its row's picker (§XI.2 R2), for the
  // caller to reload both feeds. The move itself is written here.
  onSourceMoved?: (fromFeedId: string, toFeedId: string) => void;
}

const NAME_LIMIT = 80;

export function FeedComposer({
  feed,
  open,
  onClose,
  onSourcesChanged,
  onRenamed,
  onDeleted,
  deleteBlocked,
  scheme,
  density,
  textSize,
  onSchemeChange,
  onDensityChange,
  onTextSizeChange,
  allFeeds,
  onReorder,
  hidden,
  onHiddenChange,
  onMergeInto,
  onSourceMoved,
}: FeedComposerProps) {
  const [sources, setSources] = useState<WorkspaceFeedSource[]>([]);
  const [loading, setLoading] = useState(false);
  const ri = useResolverInput({ maxPolls: 3 });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follow-graph import (FOLLOW-GRAPH-IMPORT-ADR §7.3): a resolved external
  // account whose graph the server can read additionally offers "import
  // everyone they follow" — a NEW feed (D1), announced to the workspace via
  // the run hook; progress renders below the match well. Which protocols
  // qualify comes from the capabilities block (empty while the flag is dark).
  const [importable, setImportable] = useState<string[]>([]);
  const followImport = useFollowImportRun();

  // Phase 2 "Sync now" (§11.5): present iff this feed was minted by a
  // follow-graph import (the origin binding rides the sources response).
  const [importBinding, setImportBinding] = useState<FeedImportBinding | null>(
    null,
  );

  // Feed formulas (FEED-FORMULAS-ADR Phase 1). FEED_FORMULAS_ENABLED is a
  // SERVER flag and stays the only one — there is no NEXT_PUBLIC twin to flip
  // in lockstep. The web asks instead, because this is the layout case the
  // brake rule carves out: an action that 404s when pressed is worse than an
  // action that is absent, so the section has to know before it renders.
  const [canPublishFormula, setCanPublishFormula] = useState(false);
  // Reported up by the share section (§7). A feed with a live link says so
  // where it can be DESTROYED — deleting the feed dangles the link and it stops
  // working, which is correct and otherwise silent. A sentence, not a
  // confirmation: Q1's reasoning, one control over.
  const [hasShareLink, setHasShareLink] = useState(false);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const refreshSources = useCallback(async (feedId: string) => {
    setLoading(true);
    try {
      const data = await workspaceFeedsApi.listSources(feedId);
      setSources(data.sources);
      setImportBinding(data.importBinding ?? null);
    } catch (err) {
      setError(failureSentence(err, FEED_ERROR_LOAD_SOURCES));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void getNetworkCapabilities().then((c) =>
      setImportable(c.followImportProtocols ?? []),
    );
    void formulasAvailable().then(setCanPublishFormula);
  }, [open]);

  // Escape + scroll-lock are owned by Glasshouse; this effect only resets the
  // composer's own state and loads sources when it opens.
  useEffect(() => {
    if (!open || !feed) return;
    ri.reset();
    followImport.reset();
    setBusyKey(null);
    setError(null);
    setEditingName(false);
    setNameDraft("");
    setSavingName(false);
    setConfirmingDelete(false);
    setDeleting(false);
    void refreshSources(feed.id);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, feed, refreshSources]);

  async function handleAdd(opt: MatchOption) {
    if (!feed || busyKey) return;
    setBusyKey(opt.key);
    setError(null);
    try {
      const res = await workspaceFeedsApi.addSource(feed.id, opt.add);
      // TYPING A MEMBER'S NAME HERE IS THE SAME ACT AS PRESSING FOLLOW, so it
      // tells the shared graph store the same thing (§0ab item 6). The server
      // has written the `follows` row since the convergence; this path simply
      // discarded the answer, so a member added from the composer read as not
      // followed everywhere else on the floor until a reload.
      reportFollowState(
        opt.add.sourceType === "account" ? opt.add.accountId : null,
        res.following,
      );
      ri.reset();
      await refreshSources(feed.id);
      onSourcesChanged?.();
    } catch (err) {
      setError(apiErrorMessage(err) ?? FEED_ERROR_ADD_SOURCE);
    } finally {
      setBusyKey(null);
    }
  }

  // §7.3: importable = a resolved external account whose follow graph the
  // server can read (capabilities-gated). The option's sourceUri doubles as
  // the import origin identity.
  const canImportFollows = (opt: MatchOption) =>
    opt.add.sourceType === "external_source" &&
    "sourceUri" in opt.add &&
    importable.includes(opt.add.protocol);

  const importBusy =
    followImport.starting ||
    followImport.run?.status === "pending" ||
    followImport.run?.status === "running";

  async function handleImportFollows(opt: MatchOption) {
    if (opt.add.sourceType !== "external_source" || !("sourceUri" in opt.add))
      return;
    const ok = await followImport.start({
      protocol: opt.add.protocol as FollowImportProtocol,
      originIdentity: opt.add.sourceUri,
    });
    if (ok) ri.reset();
  }

  const renderMatchOption = (opt: MatchOption) => (
    <div key={opt.key} style={{ display: "flex", flexDirection: "column" }}>
      <button
        type="button"
        onClick={() => void handleAdd(opt)}
        disabled={busyKey === opt.key}
        className="font-sans text-ui-xs"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          background: "transparent",
          border: "none",
          color: TOKENS.panelBorder,
          cursor: busyKey === opt.key ? "default" : "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = TOKENS.matchHoverBg)
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "transparent")
        }
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {opt.label}
        </span>
        {opt.sublabel && (
          <span
            className="label-ui"
            style={{ color: TOKENS.hintFg, marginLeft: 12 }}
          >
            {opt.sublabel}
          </span>
        )}
      </button>
      {canImportFollows(opt) && (
        <button
          type="button"
          onClick={() => void handleImportFollows(opt)}
          disabled={importBusy}
          className="label-ui"
          style={{
            padding: "0 10px 8px 22px",
            background: "transparent",
            border: "none",
            color: TOKENS.hintFg,
            cursor: importBusy ? "default" : "pointer",
            textAlign: "left",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.color = TOKENS.panelBorder)
          }
          onMouseLeave={(e) => (e.currentTarget.style.color = TOKENS.hintFg)}
        >
          {FEED_IMPORT_FOLLOWS}
        </button>
      )}
    </div>
  );

  function startRename() {
    if (!feed) return;
    setNameDraft(feed.name);
    setEditingName(true);
    setError(null);
    // Focus on next tick after the input mounts.
    setTimeout(() => nameInputRef.current?.select(), 0);
  }

  function cancelRename() {
    setEditingName(false);
    setNameDraft("");
  }

  async function commitRename() {
    if (!feed || savingName) return;
    const trimmed = nameDraft.trim();
    if (trimmed.length > NAME_LIMIT) {
      setError(feedNameTooLong(NAME_LIMIT));
      return;
    }
    if (trimmed === feed.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setError(null);
    try {
      const { feed: updated } = await workspaceFeedsApi.rename(
        feed.id,
        trimmed,
      );
      onRenamed?.(updated);
      setEditingName(false);
    } catch (err) {
      setError(failureSentence(err, FEED_ERROR_RENAME));
    } finally {
      setSavingName(false);
    }
  }

  async function handleDelete() {
    if (!feed || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await workspaceFeedsApi.remove(feed.id);
      onDeleted?.(feed.id);
    } catch (err) {
      // Server copy when there is any — the starter-template refusal explains
      // what to do about it, and ApiError.message is the raw "API error 409:
      // {…}" dump, which explains nothing.
      setError(apiErrorMessage(err) ?? FEED_ERROR_DELETE);
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  async function handleRemove(sourceId: string) {
    if (!feed) return;
    setBusyKey(`remove:${sourceId}`);
    setError(null);
    // Read BEFORE the removal: the row is gone from `sources` by the time the
    // response lands, and the account id is what the store is keyed on.
    const removedAccountId =
      sources.find((s) => s.id === sourceId)?.accountId ?? null;
    try {
      const res = await workspaceFeedsApi.removeSource(feed.id, sourceId);
      reportFollowState(removedAccountId, res.following);
      await refreshSources(feed.id);
      onSourcesChanged?.();
    } catch (err) {
      setError(failureSentence(err, FEED_ERROR_REMOVE_SOURCE));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleMove(sourceId: string, targetFeedId: string) {
    if (!feed) return;
    setBusyKey(`move:${sourceId}`);
    setError(null);
    try {
      await workspaceFeedsApi.moveSource(feed.id, sourceId, targetFeedId);
      setSources((prev) => prev.filter((s) => s.id !== sourceId));
      onSourceMoved?.(feed.id, targetFeedId);
    } catch (err) {
      // The route's own sentence where it has one ("Target feed already has
      // this source", the 409 a duplicate earns).
      setError(failureSentence(err, FEED_ERROR_MOVE_SOURCE));
    } finally {
      setBusyKey(null);
    }
  }

  if (!open || !feed) return null;

  const showAppearance = onSchemeChange || onDensityChange || onTextSizeChange;

  // Every OTHER feed, in the member's order, hidden ones included and marked:
  // a hidden feed is a real feed, so it can take a source or a merge.
  const otherFeeds = [...(allFeeds ?? [])]
    .filter((f) => f.id !== feed.id)
    .sort(
      (a, b) =>
        a.sortRank - b.sortRank ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

  return (
    <Glasshouse
      onClose={onClose}
      maxWidth={520}
      // An untitled feed is an ordinary feed (migration 190), so the label
      // cannot end in the name — it would announce "Feed composer:" and stop.
      // The visible title already says "No name"; this is its spoken twin.
      ariaLabel={`Channel composer: ${feed.name.trim() || "unnamed channel"}`}
      persistKey="feed-composer"
    >
      {/* Right padding clears the Glasshouse ✕ at top-right. data-explain is
          the composer's Explain base kind (C2): answers any interior hover a
          more specific leaf doesn't. */}
      <div
        className="overflow-y-auto max-h-[var(--gh-h)]"
        style={{ padding: 24 }}
        data-explain="feedComposer"
      >
        <div style={{ marginBottom: 16, paddingRight: 28 }}>
          <div className="label-ui" style={{ color: TOKENS.hintFg }}>
            {FEED_COMPOSER_TITLE}
          </div>
          {editingName ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 2,
              }}
            >
              <input
                ref={nameInputRef}
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelRename();
                  }
                }}
                placeholder={FEED_NAME_PLACEHOLDER}
                className="font-sans text-[18px]"
                style={{
                  flex: 1,
                  background: TOKENS.fieldBg,
                  border: "none",
                  padding: "6px 8px",
                  outline: "none",
                  color: TOKENS.panelBorder,
                }}
              />
              <button
                type="button"
                onClick={() => void commitRename()}
                disabled={savingName}
                className="label-ui"
                style={{
                  padding: "6px 10px",
                  background: "transparent",
                  color: TOKENS.panelBorder,
                  border: "none",
                  cursor: savingName ? "default" : "pointer",
                }}
              >
                {savingName ? FEED_NAME_SAVING : FEED_NAME_SAVE}
              </button>
              <button
                type="button"
                onClick={cancelRename}
                disabled={savingName}
                className="label-ui"
                style={{
                  padding: "6px 10px",
                  background: "transparent",
                  color: TOKENS.hintFg,
                  border: "none",
                  cursor: savingName ? "default" : "pointer",
                }}
              >
                {FEED_CANCEL}
              </button>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 2,
              }}
            >
              {feed.name ? (
                <div
                  className="font-sans text-[18px]"
                  style={{
                    color: TOKENS.panelBorder,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {feed.name}
                </div>
              ) : (
                <div
                  className="font-sans text-[18px]"
                  style={{
                    color: TOKENS.hintFg,
                    fontStyle: "italic",
                  }}
                >
                  {FEED_NO_NAME}
                </div>
              )}
              <button
                type="button"
                onClick={startRename}
                className="label-ui"
                style={{
                  padding: "4px 8px",
                  background: "transparent",
                  color: TOKENS.hintFg,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {feed.name ? FEED_RENAME : FEED_ADD_NAME}
              </button>
            </div>
          )}
        </div>

        <div
          className="label-ui"
          style={{ color: TOKENS.hintFg, marginBottom: 6 }}
        >
          {FEED_SOURCES_LABEL}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginBottom: 16,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {loading && (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              LOADING…
            </div>
          )}
          {!loading && sources.length === 0 && (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              {FEED_SOURCES_EMPTY}
            </div>
          )}
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              feedId={feed.id}
              busy={
                busyKey === `remove:${s.id}` || busyKey === `move:${s.id}`
              }
              onRemove={() => void handleRemove(s.id)}
              moveTargets={onSourceMoved ? otherFeeds : []}
              onMove={(target) => void handleMove(s.id, target.id)}
              onChanged={(updated) => {
                setSources((prev) =>
                  prev.map((p) => (p.id === updated.id ? updated : p)),
                );
              }}
              onCommitted={() => onSourcesChanged?.()}
            />
          ))}
        </div>

        <div
          className="label-ui"
          style={{ color: TOKENS.hintFg, marginBottom: 6 }}
        >
          {FEED_ADD_SOURCE_LABEL}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={ri.query}
          onChange={(e) => ri.onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              ri.submit();
            }
          }}
          placeholder={FEED_RESOLVER_PLACEHOLDER}
          data-explain="feedComposer.addSource"
          className="font-sans text-ui-sm w-full"
          style={{
            background: TOKENS.fieldBg,
            border: "none",
            padding: "10px 12px",
            outline: "none",
            marginBottom: 8,
          }}
        />
        {/* Reserve the match well so resolving/results don't grow the pane. */}
        <div style={{ minHeight: 24 }}>
          {ri.resolving && (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              LOOKING IT UP…
            </div>
          )}
          {(ri.doneEmpty || ri.resolveError) && (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              {FEED_RESOLVER_NO_MATCH}
            </div>
          )}
          {ri.matches.length > 0 && (
            // Confidence tiers rendered as two sections (§6.4): "Matches"
            // (exact + probable) and "Suggestions" (speculative discovery
            // nominations). The Matches header only appears when both
            // sections are present — alone it would be noise.
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {ri.sections.matches.length > 0 &&
                ri.sections.suggestions.length > 0 && (
                  <div
                    className="label-ui"
                    style={{ color: TOKENS.hintFg, padding: "2px 10px 0" }}
                  >
                    {FEED_RESOLVER_MATCHES}
                  </div>
                )}
              {ri.sections.matches.map(renderMatchOption)}
              {ri.sections.suggestions.length > 0 && (
                <div
                  className="label-ui"
                  style={{
                    color: TOKENS.hintFg,
                    padding:
                      ri.sections.matches.length > 0
                        ? "8px 10px 0"
                        : "2px 10px 0",
                  }}
                >
                  {FEED_RESOLVER_SUGGESTIONS}
                </div>
              )}
              {ri.sections.suggestions.map(renderMatchOption)}
            </div>
          )}
        </div>

        {/* Follow-import progress (§7.3): the run builds a NEW feed behind the
            glass (announced to the workspace on start); status lives here so
            the composer that launched it stays informative. */}
        {(followImport.starting || followImport.run || followImport.error) && (
          <div style={{ marginBottom: 8 }}>
            <FollowImportStatus
              starting={followImport.starting}
              run={followImport.run}
              feed={followImport.feed}
              error={followImport.error}
            />
          </div>
        )}

        {error && (
          <div
            className="font-mono text-mono-xs"
            style={{ color: TOKENS.errorFg, marginTop: 12 }}
          >
            {error}
          </div>
        )}

        {/* "Sync now" for import-bound feeds (§11.5) — only when the server
            can actually re-read this protocol's graph (capabilities gate,
            empty while the flag is dark). */}
        {importBinding && importable.includes(importBinding.protocol) && (
          <FeedSyncSection
            key={feed.id}
            feedId={feed.id}
            binding={importBinding}
            onApplied={() => {
              void refreshSources(feed.id);
              onSourcesChanged?.();
            }}
          />
        )}

        {showAppearance && (
          <>
            <div
              className="label-ui"
              style={{
                color: TOKENS.hintFg,
                marginTop: 20,
                marginBottom: 8,
              }}
            >
              Appearance
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
              }}
            >
              {onSchemeChange && (
                <SchemeMenu scheme={scheme} onSchemeChange={onSchemeChange} />
              )}
              {onDensityChange && (
                <AppearanceControl
                  label="View"
                  dataExplain="feedComposer.view"
                  glyph={
                    {
                      compact: "Condensed",
                      standard: "Standard",
                      headline: "Headline",
                    }[normalizeDensity(density)]
                  }
                  onClick={() =>
                    onDensityChange(nextDensity(normalizeDensity(density)))
                  }
                />
              )}
              {onTextSizeChange && (
                <AppearanceControl
                  label="Text size"
                  dataExplain="feedComposer.textSize"
                  glyph={
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "baseline",
                        gap: 2,
                      }}
                    >
                      <span style={{ fontSize: 18, lineHeight: 1 }}>Ɐ</span>
                      <span style={{ fontSize: 12, lineHeight: 1 }}>Ɐ</span>
                    </span>
                  }
                  indicator={`${textSize ?? DEFAULT_TEXT_SIZE}/5`}
                  onClick={() =>
                    onTextSizeChange(nextTextSize(textSize ?? DEFAULT_TEXT_SIZE))
                  }
                />
              )}
            </div>
          </>
        )}

        {/* Share this feed (FEED-SHARE-LIVE-LINKS-ADR §3). Below appearance
            because the colour scheme travels with the composition (§5), so the
            author sets the look they are handing over before they are offered
            the chance to hand it over. One bare button, like `Delete feed`
            below — it carries no heading of its own. */}
        {canPublishFormula && (
          <FeedFormulaSection feedId={feed.id} onLinkChange={setHasShareLink} />
        )}

        {onReorder && allFeeds && allFeeds.length > 1 && (
          <>
            <div
              className="label-ui"
              style={{
                color: TOKENS.hintFg,
                marginTop: 20,
                marginBottom: 6,
              }}
            >
              Channel order
            </div>
            <FeedRankList
              feeds={allFeeds}
              currentFeedId={feed.id}
              onReorder={onReorder}
            />
          </>
        )}

        <div
          style={{
            marginTop: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            minHeight: 32,
          }}
        >
          {onHiddenChange && (
            <button
              type="button"
              onClick={() => onHiddenChange(!hidden)}
              className="label-ui"
              data-explain="feedComposer.hide"
              style={{
                marginRight: "auto",
                padding: "6px 10px 6px 0",
                background: "transparent",
                color: TOKENS.hintFg,
                border: "none",
                cursor: "pointer",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = TOKENS.panelBorder)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = TOKENS.hintFg)
              }
            >
              {hidden ? FEED_UNHIDE : FEED_HIDE}
            </button>
          )}
          {/* Merge deletes THIS feed, so it is offered exactly where Delete
              is: never for the last visible feed, and not while the delete
              question is open. */}
          {onMergeInto &&
            !deleteBlocked &&
            !confirmingDelete &&
            otherFeeds.length > 0 && (
              <FeedPicker
                label={FEED_MERGE_INTO_PICK}
                ariaLabel={FEED_MERGE_INTO_PICK}
                feeds={otherFeeds}
                onPick={onMergeInto}
                dataExplain="feedComposer.merge"
                trigger="label"
              />
            )}
          {deleteBlocked ? (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              {FEED_DELETE_BLOCKED}
            </div>
          ) : confirmingDelete ? (
            <>
              <div
                className="font-mono text-mono-xs"
                style={{ color: TOKENS.hintFg, marginRight: "auto" }}
              >
                {FEED_DELETE_CONFIRM}
                {hasShareLink && FEED_SHARE_LINK_WILL_STOP}
              </div>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="label-ui"
                style={{
                  padding: "6px 10px",
                  background: "transparent",
                  color: TOKENS.hintFg,
                  border: "none",
                  cursor: deleting ? "default" : "pointer",
                }}
              >
                {FEED_CANCEL}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="label-ui"
                style={{
                  padding: "6px 10px",
                  background: "transparent",
                  color: TOKENS.errorFg,
                  border: "none",
                  cursor: deleting ? "default" : "pointer",
                }}
              >
                {deleting ? FEED_DELETING : FEED_DELETE}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="label-ui"
              data-explain="feedComposer.delete"
              style={{
                padding: "6px 10px",
                background: "transparent",
                color: TOKENS.removeFg,
                border: "none",
                cursor: "pointer",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = TOKENS.errorFg)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = TOKENS.removeFg)
              }
            >
              {FEED_DELETE_FEED}
            </button>
          )}
        </div>
      </div>
    </Glasshouse>
  );
}

// The colour-scheme glyph (feature-debt §3, GLASSHOUSE-AND-PALETTE-ADR §III.4)
// — a single solid dot in the scheme's most forceful surface, its WALLS colour
// (the saturated frame/bar spine that carries a colourway's identity). One dot
// per scheme reads as a little palette of colour chips in the SchemeMenu, and
// the trigger shows the selected scheme's dot. Every text colour derives from
// the same surfaces in tokens.ts, so picking any scheme can't produce an
// illegible feed. The schemes carry no display name (DESIGN-TUNING-FINDINGS §3),
// so the dot is the sole visual identifier. The colourway adapts to the global
// light/dark toggle, so the dot previews the WALLS of the variant for the
// CURRENT global mode (paletteFor(scheme, dark)); it carries the light island
// only so basic's neutral slugs resolve cleanly in the preview. Active state is
// a 2px ring (≥2px, the a11y exemption to the sitewide no-thin-line rule).
function SchemeDot({
  scheme,
  dark,
  size = 22,
  active = false,
}: {
  scheme: FeedScheme;
  dark: boolean;
  size?: number;
  active?: boolean;
}) {
  const pal = paletteFor(scheme, dark);
  return (
    <span
      aria-hidden="true"
      style={{
        ...LIGHT_ISLAND_STYLE,
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: pal.walls,
        // Ring colour keys off the global mode explicitly (the documented
        // dark-disc-glyph bug class, §0h.5): the span is islanded, so
        // var(--ah-ink) resolves canonical DARK ink even in dark mode — over
        // the menu's non-islanded, inverting ground that made the active ring
        // dark-on-dark. Bone reads on the dark ground exactly as ink does on
        // the light one.
        outline: active
          ? `2px solid ${dark ? "var(--ah-bone)" : "var(--ah-ink)"}`
          : "none",
        outlineOffset: 2,
      }}
    />
  );
}

// The Colour control — a menu, not a click-through cycle. The trigger shows the
// selected scheme's dot (+ a ▾ affordance); opening drops a little palette: one
// SchemeDot per scheme in a row, click to pick. Closes on pick, outside click,
// or Escape. Replaces the four-way AppearanceControl cycle for colour only
// (density/orientation/text-size stay cycles — a handful of ordered steps, not a
// swatch set).
function SchemeMenu({
  scheme,
  onSchemeChange,
}: {
  scheme: FeedScheme | undefined;
  onSchemeChange: (s: FeedScheme) => void;
}) {
  const dark = useColorScheme((s) => s.dark);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = normalizeBrightness(scheme);

  // Escape via the shared shield (§0k.3, the pattern's one home): closes the
  // colour menu WITHOUT dismissing the whole FeedComposer (§0i.7).
  useEscapeShield(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    // Menus receive focus on open (§0f-18): land on the checked swatch so
    // arrow keys work immediately.
    (
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
    )?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  // role="menu" contract: arrow keys rove focus between the swatches (§0f-18).
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = idx < 0 ? 0 : (idx + 1) % items.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = items.length - 1;
    }
    if (next >= 0) {
      e.preventDefault();
      items[next].focus();
    }
  };

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
      data-explain="feedComposer.colour"
    >
      <div className="label-ui" style={{ color: TOKENS.hintFg }}>
        Colour
      </div>
      <div ref={ref} style={{ position: "relative", width: 104 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Colour scheme"
          className="font-sans text-ui-sm focus-ring"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            width: 104,
            height: 34,
            padding: "0 10px",
            boxSizing: "border-box",
            background: open ? TOKENS.fieldBg : TOKENS.matchHoverBg,
            color: TOKENS.panelBorder,
            cursor: "pointer",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = TOKENS.fieldBg)
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = open
              ? TOKENS.fieldBg
              : TOKENS.matchHoverBg)
          }
        >
          <SchemeDot scheme={current} dark={dark} size={18} />
          <span
            aria-hidden="true"
            style={{ fontSize: 9, lineHeight: 1, color: TOKENS.hintFg }}
          >
            ▾
          </span>
        </button>

        {open && (
          <div
            ref={menuRef}
            role="menu"
            onKeyDown={onMenuKeyDown}
            className="shadow-lg"
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              zIndex: TOKENS.hoverZ,
              display: "flex",
              gap: 10,
              padding: 10,
              borderRadius: 4,
              background: TOKENS.fieldBg,
            }}
          >
            {SCHEME_OPTIONS.map(({ id }) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={id === current}
                // The internal colourway id IS the accessible name, on
                // purpose: "no display name" is a visual-register decision
                // (the dot is the identifier), but an unnamed radio set is
                // unusable to AT — see GLASSHOUSE-AND-PALETTE-ADR §III.4.
                aria-label={`Colour scheme: ${id}`}
                className="focus-ring"
                onClick={() => {
                  onSchemeChange(id);
                  setOpen(false);
                }}
                style={{
                  display: "inline-flex",
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  lineHeight: 0,
                }}
              >
                <SchemeDot
                  scheme={id}
                  dark={dark}
                  size={22}
                  active={id === current}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Drag-to-rank list (MOBILE-LAYOUT-ADR §VII.4). One component for both
// surfaces, so the drag is pointer-event based (HTML5 DnD has no touch
// translation). Rows live-reorder while dragging; the new order commits on
// release. Numerals are IDENTITY (NAV-ROW-MUSTER-ADR §III): derived live over
// every feed in the rank order, hidden included, so a hidden feed keeps its
// number and this list previews exactly what the desktop badges show. `order`
// is the numbering domain and already includes hidden feeds, so dragging one to
// a new number needs no restore first — this list is the sole renumber surface.
const RANK_ROW_H = 34;
const RANK_ROW_GAP = 6;

function FeedRankList({
  feeds,
  currentFeedId,
  onReorder,
}: {
  feeds: WorkspaceFeed[];
  currentFeedId: string;
  onReorder: (feedIds: string[]) => void;
}) {
  const ranked = [...feeds].sort(
    (a, b) =>
      a.sortRank - b.sortRank ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const rankedIds = ranked.map((f) => f.id);
  const [order, setOrder] = useState<string[]>(rankedIds);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string;
    startY: number;
    startIndex: number;
  } | null>(null);

  // Re-sync from the canonical order whenever it changes (rename, server
  // reconcile) — but never mid-drag, or the row would jump under the pointer.
  const rankedKey = rankedIds.join("|");
  useEffect(() => {
    if (!draggingId) setOrder(rankedKey.split("|"));
  }, [rankedKey, draggingId]);

  const byId = new Map(feeds.map((f) => [f.id, f]));
  const stride = RANK_ROW_H + RANK_ROW_GAP;

  function moveTo(id: string, target: number) {
    setOrder((prev) => {
      const clamped = Math.max(0, Math.min(prev.length - 1, target));
      if (prev.indexOf(id) === clamped) return prev;
      const next = prev.filter((x) => x !== id);
      next.splice(clamped, 0, id);
      return next;
    });
  }

  function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>, id: string) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, startY: e.clientY, startIndex: order.indexOf(id) };
    setDraggingId(id);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = Math.round((e.clientY - drag.startY) / stride);
    moveTo(drag.id, drag.startIndex + delta);
  }

  function handlePointerEnd() {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDraggingId(null);
    if (order.some((id, i) => id !== rankedIds[i])) onReorder(order);
  }

  // Keyboard re-rank on the same handle: each arrow press commits (feeds are
  // few; a PATCH per step is cheap and keeps the badges live).
  function handleKeyDown(e: React.KeyboardEvent, id: string) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const index = order.indexOf(id);
    const target = e.key === "ArrowUp" ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) return;
    const next = order.filter((x) => x !== id);
    next.splice(target, 0, id);
    setOrder(next);
    onReorder(next);
  }

  let numeral = 0;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: RANK_ROW_GAP,
        marginBottom: 4,
      }}
      data-explain="feedComposer.order"
    >
      {order.map((id) => {
        const f = byId.get(id);
        if (!f) return null;
        const num = ++numeral;
        const isCurrent = f.id === currentFeedId;
        const isDragging = draggingId === f.id;
        const name = f.name.trim();
        return (
          <div
            key={f.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: RANK_ROW_H,
              padding: "0 4px 0 10px",
              background: isDragging ? TOKENS.fieldBg : TOKENS.rowBg,
              boxShadow: isDragging ? "0 2px 6px rgba(0, 0, 0, 0.15)" : undefined,
              position: "relative",
              zIndex: isDragging ? 1 : undefined,
            }}
          >
            <span
              className="font-mono text-[11px]"
              style={{
                color: TOKENS.hintFg,
                width: 18,
                flexShrink: 0,
                textAlign: "right",
              }}
            >
              {num}
            </span>
            <span
              className="font-sans text-ui-xs"
              style={{
                color: f.hidden
                  ? TOKENS.hintFg
                  : TOKENS.panelBorder,
                fontWeight: isCurrent ? 600 : undefined,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {name || FEED_UNNAMED}
            </span>
            {f.hidden && (
              <span className="label-ui" style={{ color: TOKENS.hintFg }}>
                hidden
              </span>
            )}
            <button
              type="button"
              aria-label={`Reorder ${name || "unnamed channel"} (drag, or arrow keys)`}
              onPointerDown={(e) => handlePointerDown(e, f.id)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              onKeyDown={(e) => handleKeyDown(e, f.id)}
              style={{
                background: "transparent",
                border: "none",
                color: TOKENS.hintFg,
                cursor: isDragging ? "grabbing" : "grab",
                touchAction: "none",
                padding: "6px 10px",
                fontSize: 14,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              ≡
            </button>
          </div>
        );
      })}
    </div>
  );
}

function AppearanceControl({
  label,
  glyph,
  indicator,
  dataExplain,
  onClick,
}: {
  label: string;
  glyph: React.ReactNode;
  indicator?: string;
  /** Explain kind tag (C2) — same pattern as Byline/VesselBar. */
  dataExplain?: string;
  onClick: () => void;
}) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
      data-explain={dataExplain}
    >
      <div className="label-ui" style={{ color: TOKENS.hintFg }}>
        {label}
      </div>
      <button
        type="button"
        onClick={onClick}
        className="font-sans text-ui-sm"
        style={{
          // Fixed footprint: the glyph/indicator/label swap as the control
          // cycles, but the button must never change size — otherwise the
          // wrap row reflows and the whole modal visibly jumps. Content is
          // centred so each step recentres inside a stable box.
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          width: 104,
          height: 34,
          padding: "0 10px",
          boxSizing: "border-box",
          // Resting affordance is a subtle fill (the design system bans thin
          // rules sitewide); hover deepens it.
          background: TOKENS.matchHoverBg,
          color: TOKENS.panelBorder,
          cursor: "pointer",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = TOKENS.fieldBg)
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = TOKENS.matchHoverBg)
        }
      >
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          {glyph}
        </span>
        {indicator && (
          <span className="label-ui" style={{ color: TOKENS.hintFg }}>
            {indicator}
          </span>
        )}
      </button>
    </div>
  );
}

function SourceRow({
  source,
  feedId,
  busy,
  onRemove,
  moveTargets,
  onMove,
  onChanged,
  onCommitted,
}: {
  source: WorkspaceFeedSource;
  feedId: string;
  busy: boolean;
  onRemove: () => void;
  // The feeds this source may move to (§XI.2 R2) — every other feed the
  // member has. Empty means no picker: with one feed there is nowhere to go.
  moveTargets: WorkspaceFeed[];
  onMove: (target: WorkspaceFeed) => void;
  // Optimistic local update of the composer's source list (no feed reload).
  onChanged: (updated: WorkspaceFeedSource) => void;
  // Fired once after a change is committed server-side, so the parent can
  // reload the feed behind the glass exactly once (not on the optimistic tick).
  onCommitted: () => void;
}) {
  const [committing, setCommitting] = useState(false);
  const isMuted = source.mutedAt !== null;
  const currentStep = isMuted ? 0 : throughputToStep(source.throughput);
  // Nothing to sample when everything is already coming through.
  const samplingMoot = isMuted || currentStep === 5;
  const sampling = source.samplingMode;
  const excludeReplies = source.excludeReplies;

  // Account sources route + hover exactly like a feed-card byline; the hover
  // author-card portals above the Glasshouse via the zIndex override.
  const hover = useAuthorHover(
    "author",
    source.sourceType === "account" ? (source.accountId ?? null) : null,
  );

  // Every commit updates the row optimistically (instant, no shudder) and
  // reconciles with the authoritative row, reverting on failure. The feed
  // behind the glass reloads once, after the commit settles.
  async function commit(
    optimistic: WorkspaceFeedSource,
    body: {
      step?: number;
      sampling?: "random" | "top";
      muted?: boolean;
      excludeReplies?: boolean;
    },
  ) {
    if (committing) return;
    const prev = source;
    setCommitting(true);
    onChanged(optimistic);
    try {
      const { source: updated } = await workspaceFeedsApi.patchSource(
        feedId,
        source.id,
        body,
      );
      onChanged(updated);
      onCommitted();
    } catch {
      onChanged(prev);
    } finally {
      setCommitting(false);
    }
  }

  function commitStep(nextStep: number) {
    void commit(
      {
        ...source,
        mutedAt: nextStep === 0 ? new Date().toISOString() : null,
        throughput:
          nextStep === 0 ? source.throughput : VOLUME_THROUGHPUT[nextStep],
      },
      { step: nextStep, muted: nextStep === 0 },
    );
  }

  function commitSampling(next: "random" | "top") {
    void commit({ ...source, samplingMode: next }, { sampling: next });
  }

  function commitExcludeReplies(next: boolean) {
    void commit(
      { ...source, excludeReplies: next },
      { excludeReplies: next },
    );
  }

  const label = source.display.label;
  const href = source.display.href;

  return (
    <div
      style={{ background: TOKENS.rowBg, padding: "8px 10px" }}
      data-explain="feedComposer.source"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          {href ? (
            <Link
              href={href}
              ref={hover.bylineRef as React.Ref<HTMLAnchorElement>}
              onMouseEnter={hover.onMouseEnter}
              onMouseLeave={hover.onMouseLeave}
              onClick={(e) => {
                // Open the matching URL-synced Glasshouse overlay in place —
                // never a full-page navigation that would escape the workspace
                // to the black topbar. Account → profile overlay; publication /
                // external source / tag → surface overlay. Gate the account case
                // strictly on the source type: openProfileHref reads the href
                // alone and would mis-classify /pub/:slug, /source/:id and
                // /tag/:name as a native profile, so route those through
                // openSurfaceHref instead. Modified clicks (new tab) fall
                // through to the real link.
                if (isModifiedClick(e)) return;
                const handled =
                  source.sourceType === "account"
                    ? openProfileHref(href)
                    : openSurfaceHref(href);
                if (handled) {
                  e.preventDefault();
                  hover.onModalClose();
                }
              }}
              className="font-sans text-ui-xs hover:underline"
              style={{
                color: isMuted ? TOKENS.hintFg : TOKENS.panelBorder,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textDecoration: isMuted ? "line-through" : undefined,
              }}
            >
              {label}
            </Link>
          ) : (
            <div
              className="font-sans text-ui-xs"
              style={{
                color: isMuted ? TOKENS.hintFg : TOKENS.panelBorder,
                overflow: "hidden",
                textOverflow: "ellipsis",
                textDecoration: isMuted ? "line-through" : undefined,
              }}
            >
              {label}
            </div>
          )}
          {source.display.sublabel && (
            <div className="label-ui" style={{ color: TOKENS.hintFg }}>
              {source.display.sublabel}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={feedSourceRemove(label)}
          style={{
            background: "transparent",
            border: "none",
            color: TOKENS.removeFg,
            cursor: "pointer",
            fontSize: 16,
            padding: "4px 8px",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.color = TOKENS.removeHoverFg)
          }
          onMouseLeave={(e) => (e.currentTarget.style.color = TOKENS.removeFg)}
        >
          ×
        </button>
      </div>

      {/* Controls always render (even when muted, dimmed) so toggling never
          reflows the row — the prior mute-driven show/hide was the shudder. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 6,
          flexWrap: "wrap",
        }}
        data-explain="feedComposer.volume"
      >
        {/* Volume: 0=mute, 1..5 = the fraction of this source's posts that
            reach this feed. Step 5 (everything) is the default. */}
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          {[0, 1, 2, 3, 4, 5].map((s) => {
            const active = !isMuted && s > 0 && s <= currentStep;
            const muteActive = isMuted && s === 0;
            return (
              <button
                key={s}
                type="button"
                onClick={() => commitStep(s)}
                disabled={committing}
                aria-label={s === 0 ? FEED_SOURCE_MUTE : feedSourceVolume(stepPercent(s))}
                style={{
                  width: s === 0 ? 20 : 16,
                  height: 16,
                  background: muteActive
                    ? TOKENS.errorFg
                    : active
                      ? TOKENS.panelBorder
                      : TOKENS.fieldBg,
                  border: "none",
                  cursor: committing ? "default" : "pointer",
                  padding: 0,
                  fontSize: 9,
                  color: muteActive ? "var(--ah-white)" : TOKENS.hintFg,
                  fontFamily: "IBM Plex Mono, ui-monospace, monospace",
                }}
              >
                {s === 0 ? "×" : ""}
              </button>
            );
          })}
        </div>

        {/* Sampling + no-replies are moot while muted — dimmed but kept in
            place so unmuting doesn't jump the layout. Sampling is equally moot
            at full volume: there is no fraction to choose between when every
            post is coming through. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            opacity: isMuted ? 0.4 : 1,
          }}
        >
          <div
            style={{ display: "flex", gap: 3, opacity: samplingMoot ? 0.4 : 1 }}
          >
            {(["random", "top"] as const).map((mode) => {
              const on = sampling === mode;
              return (
                <Chip
                  key={mode}
                  label={
                    mode === "top" && !source.hasEngagementSignal
                      ? FEED_SOURCE_SAMPLING_RECENT
                      : FEED_SOURCE_SAMPLING_LABEL[mode]
                  }
                  active={on}
                  disabled={committing || isMuted || samplingMoot}
                  onClick={() => commitSampling(mode)}
                  title={
                    mode === "top" && !source.hasEngagementSignal
                      ? FEED_SOURCE_NO_SIGNAL_TITLE
                      : undefined
                  }
                />
              );
            })}
          </div>
          <Chip
            label={FEED_SOURCE_NO_REPLIES}
            active={excludeReplies}
            disabled={committing || isMuted}
            onClick={() => commitExcludeReplies(!excludeReplies)}
            title={FEED_SOURCE_NO_REPLIES_TITLE}
          />
        </div>

        {/* Beside the volume and never on the byline: feed management stays
            out of reading surfaces (WORKSPACE-QUEUE-ADR §XI.2 R2). Full
            strength even while muted — moving a muted source is still a move,
            and it arrives muted. */}
        {moveTargets.length > 0 && (
          <div style={{ marginLeft: "auto" }}>
            <FeedPicker
              label={FEED_SOURCE_MOVE}
              ariaLabel={feedSourceMoveTo(label)}
              heading={FEED_SOURCE_MOVE_TO}
              feeds={moveTargets}
              onPick={onMove}
              disabled={busy || committing}
              dataExplain="feedComposer.move"
              trigger="chip"
            />
          </div>
        )}
      </div>

      {hover.open && hover.id && (
        <AuthorModal
          type="author"
          id={hover.id}
          anchorRef={hover.bylineRef}
          onClose={hover.onModalClose}
          onMouseEnter={hover.onModalMouseEnter}
          onMouseLeave={hover.onModalMouseLeave}
          zIndex={TOKENS.hoverZ}
          feedId={feedId}
        />
      )}
    </div>
  );
}

// A feed picker hung off a control in the panel — the source row's Move and the
// panel's Merge into (WORKSPACE-QUEUE-ADR §XI.2 R1/R2). It only CHOOSES: the
// caller writes. The list portals out of the pane through AnchoredPopover (the
// pane clips, and its frame paints over anything inside it), over `paper`
// because the pane is white and a glasshouse list on it would be white on
// white. Rows say HIDDEN the way the Follow picker's do.
function FeedPicker({
  label,
  ariaLabel,
  heading,
  feeds,
  onPick,
  disabled,
  dataExplain,
  trigger,
}: {
  label: string;
  ariaLabel: string;
  /** A line over the list, where the trigger's own word does not say where
   *  the thing is going ("Move" → "Move to"). */
  heading?: string;
  feeds: WorkspaceFeed[];
  onPick: (feed: WorkspaceFeed) => void;
  disabled?: boolean;
  dataExplain: string;
  /** `chip` sits in a source row's control strip; `label` in the panel's
   *  bottom row beside Hide and Delete. */
  trigger: "chip" | "label";
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chip = trigger === "chip";
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-explain={dataExplain}
        className={
          chip
            ? "font-mono text-[10px] uppercase tracking-[0.04em]"
            : "label-ui"
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: chip ? TOKENS.fieldBg : "transparent",
          color: TOKENS.hintFg,
          border: "none",
          cursor: disabled ? "default" : "pointer",
          padding: chip ? "3px 7px" : "6px 10px",
          whiteSpace: "nowrap",
        }}
      >
        {label}
        <Pointer direction="down" size="sm" className="ml-1" />
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onDismiss={() => setOpen(false)}
        width={220}
        over="paper"
        ariaLabel={ariaLabel}
        className="py-1"
      >
        {heading && (
          <div className="label-ui text-grey-600 px-3 pt-1 pb-1.5">
            {heading}
          </div>
        )}
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          {feeds.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(f);
              }}
              className="flex w-full items-center px-3 py-1.5 text-left text-ui-sm text-black hover:bg-grey-200 transition-colors"
            >
              <span className="truncate">
                {f.name.trim() || FEED_UNNAMED}
                {f.hidden && (
                  <span className="label-ui ml-2 text-grey-600">HIDDEN</span>
                )}
              </span>
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}

// Borderless mono-caps toggle chip — active is a dark fill, inactive a recessed
// fill. Fixed by its (constant) label text so toggling only swaps colour, never
// width, keeping the row steady.
function Chip({
  label,
  active,
  disabled,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="font-mono text-[10px] uppercase tracking-[0.04em]"
      style={{
        background: active ? TOKENS.panelBorder : TOKENS.fieldBg,
        color: active ? "var(--ah-white)" : TOKENS.hintFg,
        border: "none",
        cursor: disabled ? "default" : "pointer",
        padding: "3px 7px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
