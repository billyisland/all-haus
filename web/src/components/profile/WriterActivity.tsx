"use client";

// =============================================================================
// WriterActivity — tiers 3 and 4 of the native profile: the view row and the
// log beneath it (PROFILE-PANE-REDESIGN-ADR D11, as amended 2026-09-02).
//
// FIVE VIEWS, ONE ROW. Articles · Posts · Replies · Followers · Following, each
// a rectangular button switching the region below. This replaces two things
// that were the same navigation stated twice: the Work · Social pill rig here,
// and the Followers/Following buttons up in tier 2 that *replaced* this region
// from outside it. That split is the only reason the old followers view needed
// a `← back` — with all five in one row, every view is reachable from every
// other and there is nowhere to go back to.
//
// THE BUTTONS ARE NAMES, NOT TALLIES (operator, 2026-09-02). The counts rode
// the buttons for a week and were removed: a row of five numbers is a scoreboard
// on a surface that is a way in, and it reads loudest on the profiles with the
// least behind them. RSS keeps its seat at the END of the row (D12) and is
// deliberately NOT a button: it is the one human-visible RSS affordance on the
// site, and it leaves the page rather than switching a view.
//
// THE COUNTS STILL ARRIVE, and are still load-bearing — they just do not print.
// A VIEW IS OFFERED ONLY IF IT HAS SOMETHING IN IT (no articles, no Articles
// button), which needs every count BEFORE the first paint: that is why
// noteCount/replyCount are fields on GET /writers/:username and not something
// derived from the logs' own fetches — derived, two buttons would appear a beat
// after load and move the selected view under the reader. A count the gateway
// did not send (an older image) is UNKNOWN, not zero, and the view is offered,
// because hiding a log that is actually there is the worse failure of the two.
//
// What the printed count was ALSO doing was making a silent 500 visible — a
// number the reader could hold against the list under it is how `following`'s
// long-standing outage was caught, rendering as "Not following anyone yet". Both
// count views now carry their own failure branch instead, which is where that
// job belonged: the *outage renders as an outage* rule, not a tally beside it.
//
// FIVE WILL NOT FIT ONE PHONE ROW and no bar sizing makes them: four came to
// ~350px against 327px of content width at 375px, which is what cut the old rig
// to two. The row wraps. It is a `flex-wrap`, not a scroller — a horizontally
// scrolled row hides navigation behind a gesture nothing announces.
//
// The buttons take the SURFACE'S PALETTE, not `.tab-pill-active/-inactive`:
// this pane wears the launching feed's colourway entire, and those classes are
// a flat ink/grey pair that would sit unchanged inside a green vessel and
// unreadable in a dark one. They keep `.tab-pill` for its TYPE (mono caps,
// 11px, square) — the shape was always right, only the colour was fixed.
// =============================================================================

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { WriterProfile } from "../../lib/api";
import type { VesselPalette } from "../workspace/tokens";
import { WorkTab } from "./WorkTab";
import { SocialLog } from "./SocialLog";
import { FollowersTab } from "./FollowersTab";
import { FollowingTab } from "./FollowingTab";

type ProfileView =
  | "articles"
  | "posts"
  | "replies"
  | "followers"
  | "following";

const VIEW_ORDER: ProfileView[] = [
  "articles",
  "posts",
  "replies",
  "followers",
  "following",
];

/** The URL's `?tab=`, whose vocabulary predates the five views. `work`/`social`
 *  are kept readable so a link anyone has already shared still lands somewhere
 *  sensible rather than silently on Articles. */
const LEGACY_TAB: Record<string, ProfileView> = {
  work: "articles",
  social: "posts",
};

/** What each button says. Plural throughout — the button names a view, not its
 *  contents, so a one-article profile still reads ARTICLES. */
const VIEW_WORD: Record<ProfileView, string> = {
  articles: "ARTICLES",
  posts: "POSTS",
  replies: "REPLIES",
  followers: "FOLLOWERS",
  following: "FOLLOWING",
};

interface WriterActivityProps {
  username: string;
  writer: WriterProfile;
  isOwnProfile: boolean;
  palette: VesselPalette;
  // Hosted inside the profile overlay (NativeProfilePanel). The overlay's
  // pushed URL is /<username>, so we ignore the ambient ?tab the workspace URL
  // may carry and drive view state internally (`select` still reflects it onto
  // the URL).
  inOverlay?: boolean;
}

export function WriterActivity({
  username,
  writer,
  isOwnProfile,
  palette,
  inOverlay = false,
}: WriterActivityProps) {
  const searchParams = useSearchParams();

  // A count the gateway did not send is `undefined` — the view is offered — and
  // is NOT the same fact as 0, which hides the button. Nothing else reads these.
  const counts: Record<ProfileView, number | undefined> = {
    articles: writer.articleCount,
    posts: writer.noteCount,
    replies: writer.replyCount,
    followers: writer.followerCount,
    following: writer.followingCount,
  };

  const views = VIEW_ORDER.filter((v) => counts[v] !== 0);

  const rawTab = inOverlay ? null : searchParams.get("tab");
  const requested = rawTab ? (LEGACY_TAB[rawTab] ?? rawTab) : null;
  const initialView: ProfileView =
    requested && views.includes(requested as ProfileView)
      ? (requested as ProfileView)
      : (views[0] ?? "articles");

  const [activeView, setActiveView] = useState<ProfileView>(initialView);
  // A writer's first article makes the Articles button appear; if the row has
  // shrunk back under the selection, the state must follow it rather than
  // render a panel no button can reach.
  const view: ProfileView = views.includes(activeView)
    ? activeView
    : (views[0] ?? "articles");

  function select(next: ProfileView) {
    setActiveView(next);
    const url = new URL(window.location.href);
    // Articles is the default view, so it is the ABSENCE of the param — a
    // canonical /username stays a bare /username.
    if (next === "articles") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState({}, "", url.toString());
  }

  const panel = (() => {
    switch (view) {
      case "articles":
        // WorkTab, not an "articles" component: it also carries pledge drives,
        // which are parked behind PLEDGES_ENABLED and so invisible today.
        return (
          <WorkTab
            username={username}
            writer={writer}
            isOwnProfile={isOwnProfile}
            palette={palette}
          />
        );
      case "posts":
      case "replies":
        return (
          <SocialLog
            kind={view === "posts" ? "notes" : "replies"}
            writer={writer}
            isOwnProfile={isOwnProfile}
            palette={palette}
          />
        );
      case "followers":
        return (
          <FollowersTab
            username={username}
            isOwnProfile={isOwnProfile}
            palette={palette}
          />
        );
      case "following":
        return (
          <FollowingTab
            username={username}
            isOwnProfile={isOwnProfile}
            palette={palette}
          />
        );
    }
  })();

  if (views.length === 0) {
    // Every count is zero: a brand-new account, which has no row to draw and
    // nothing to put under one. One line, in the log's own muted tone.
    return (
      <p className="text-ui-sm py-10" style={{ color: palette.cardMeta }}>
        {isOwnProfile
          ? "Nothing here yet — publish an article or post a note to fill this in."
          : "Nothing here yet."}
      </p>
    );
  }

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2 mb-4"
        role="tablist"
        aria-label="Profile views"
      >
        {views.map((v, i) => {
          const active = view === v;
          return (
            <button
              key={v}
              role="tab"
              aria-selected={active}
              aria-controls={`profile-panel-${v}`}
              id={`profile-tab-${v}`}
              onClick={() => select(v)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  select(views[(i + 1) % views.length]);
                  e.preventDefault();
                }
                if (e.key === "ArrowLeft") {
                  select(views[(i - 1 + views.length) % views.length]);
                  e.preventDefault();
                }
              }}
              tabIndex={active ? 0 : -1}
              className="tab-pill focus-ring transition-opacity hover:opacity-85"
              style={
                active
                  ? // The photo-negative of the ground, exactly as `BarButton`'s
                    // primary is of the bar — so the selection reads the same
                    // way in every colourway and in both modes.
                    { background: palette.cardTitle, color: palette.interior }
                  : { background: palette.cardBg, color: palette.cardStandfirst }
              }
            >
              {VIEW_WORD[v]}
            </button>
          );
        })}

        {/* RSS: the end of the row (D12), and visibly not one of the buttons —
            it leaves the page rather than switching a view. */}
        <a
          href={`/rss/${username}`}
          className="text-mono-xs ml-1 hover:underline"
          style={{ color: palette.cardStandfirst }}
        >
          RSS
        </a>
      </div>

      <div
        role="tabpanel"
        id={`profile-panel-${view}`}
        aria-labelledby={`profile-tab-${view}`}
      >
        {panel}
      </div>
    </>
  );
}
