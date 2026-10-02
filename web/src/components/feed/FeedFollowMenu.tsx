"use client";

import { useState } from "react";
import type { FeedFollowState } from "../../hooks/useFeedFollow";

// =============================================================================
// FeedFollowMenu — the body of the "Follow ▾" feed picker, shared by both
// surfaces that have to ask which feed a follow lands in: the profile bar's
// portalled popover (`ProfileFollowControl`) and the byline hover panel
// (`AuthorModal`, where it renders INSIDE the panel's own box). One list, one
// wording, one set of affordances — the two had no business drifting.
//
// It renders the STATE and nothing else; every write lives in `useFeedFollow`.
//
// Two registers, because the two hosts have different grounds: the popover is
// `bg-glasshouse` (its well inverts with the mode), the hover panel is a
// hard-coded white card (so it takes the non-inverting greys the rest of that
// panel is built from). Nothing else differs.
// =============================================================================

const REGISTER = {
  glasshouse: {
    row: "hover:bg-glasshouse-well",
    text: "text-black",
    muted: "text-grey-600",
    field: "bg-glasshouse-well",
  },
  panel: {
    row: "hover:bg-grey-100",
    text: "text-black",
    muted: "text-grey-600",
    field: "bg-grey-100",
  },
} as const;

export function FeedFollowMenu({
  state,
  register = "glasshouse",
  /** Caps the scrolling feed list. The hover panel needs one so the whole
   *  panel stays inside the ~320px budget its position was computed against
   *  (AuthorModal's one-shot above/below decision). */
  maxListHeight,
}: {
  state: FeedFollowState;
  register?: keyof typeof REGISTER;
  maxListHeight?: number;
}) {
  const {
    feeds,
    membership,
    busyFeeds,
    loadFailed,
    error,
    strandedFollow,
    toggleFeed,
    createAndFollow,
    dropStrandedFollow,
  } = state;

  const [newMode, setNewMode] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [dropping, setDropping] = useState(false);

  const r = REGISTER[register];

  async function create() {
    if (creating || !newName.trim()) return;
    setCreating(true);
    const ok = await createAndFollow(newName);
    setCreating(false);
    if (ok) {
      setNewMode(false);
      setNewName("");
    }
    // On failure the input stays open so the name isn't lost.
  }

  if (feeds === null) {
    return <p className={`label-ui ${r.muted} px-2 py-2`}>LOADING…</p>;
  }

  return (
    <>
      {/* The legacy state: followed in the graph, in no feed, so there is no
          tick to remove and the reader would otherwise be stuck "Following"
          someone whose posts never arrive. Says what is true and offers the
          two ways out — put them in a feed, or stop following. */}
      {strandedFollow && (
        <div className="px-2 pt-1.5 pb-1">
          <p className={`text-ui-xs ${r.muted}`}>
            You follow them, but no channel carries their posts.
          </p>
          <button
            onClick={async () => {
              setDropping(true);
              await dropStrandedFollow();
              setDropping(false);
            }}
            disabled={dropping}
            className="btn-text-danger mt-1 disabled:opacity-50"
          >
            {dropping ? "…" : "Unfollow"}
          </button>
        </div>
      )}

      {loadFailed ? (
        <p className={`text-ui-xs ${r.muted} px-2 py-2`}>
          Couldn&rsquo;t load your channels. Close this and try again.
        </p>
      ) : (
        feeds.length === 0 && !newMode && (
          <p className={`text-ui-xs ${r.muted} px-2 py-2`}>No channels yet.</p>
        )
      )}

      <div
        style={
          maxListHeight ? { maxHeight: maxListHeight, overflowY: "auto" } : undefined
        }
      >
        {feeds.map((f) => {
          const inFeed = !!membership?.[f.id];
          const busy = busyFeeds.has(f.id);
          return (
            <button
              key={f.id}
              onClick={() => void toggleFeed(f.id)}
              disabled={busy}
              className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-ui-sm ${r.text} ${r.row} transition-colors disabled:opacity-50`}
            >
              {/* A feed's name is optional (migration 190); without this the row
                  for an untitled feed is a blank line you cannot tell from its
                  neighbours. Same wording as the ∀ menu's restore rows. */}
              <span className="truncate">
                {f.name.trim() || "Unnamed channel"}
                {/* A hidden feed is still a real feed and still ingests, so it
                    is offered — but say so, or a source placed there looks
                    like it went nowhere. */}
                {f.hidden && (
                  <span className={`label-ui ml-2 ${r.muted}`}>HIDDEN</span>
                )}
              </span>
              <span
                className={`text-ui-sm ${inFeed ? "text-crimson" : "text-grey-300"}`}
                aria-hidden
              >
                {busy ? "…" : inFeed ? "✓" : "+"}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="text-ui-xs text-crimson px-2 py-1.5">
          {error}
        </p>
      )}

      {newMode ? (
        <div className="flex items-center gap-1.5 px-1 pt-1.5">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") setNewMode(false);
            }}
            placeholder="New channel name"
            className={`min-w-0 flex-1 ${r.field} px-2 py-1.5 text-ui-sm ${r.text} placeholder:text-grey-300 focus:outline-none`}
          />
          <button
            onClick={() => void create()}
            disabled={creating || !newName.trim()}
            className="btn py-1.5 px-3 text-ui-xs disabled:opacity-50"
          >
            {creating ? "…" : "Add"}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setNewMode(true)}
          className={`w-full px-2 py-1.5 text-left text-ui-sm ${r.muted} ${r.row} transition-colors`}
        >
          + New channel…
        </button>
      )}
    </>
  );
}
