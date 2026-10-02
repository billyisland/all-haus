// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { routeToOverlay } from "../src/lib/workspace/overlays";
import {
  openPostInReader,
  canOpenPostInReader,
} from "../src/lib/workspace/open-post";
import { useWorkspaceSurface } from "../src/stores/workspaceSurface";
import { useMessagesOverlay } from "../src/stores/messagesOverlay";
import { useSettingsOverlay } from "../src/stores/settingsOverlay";
import { useProfile } from "../src/stores/profileOverlay";
import { useUnreadCounts } from "../src/stores/unread";
import { useAuth } from "../src/stores/auth";
import { useReader } from "../src/stores/reader";
import type { Post } from "../src/lib/post/types";

// =============================================================================
// S19 — where a workspace-reachable surface sends the reader.
//
// Two rules, both of which had shipped broken in both directions, and both of
// which are invisible from a status code or a rendered tree: the button either
// opens the surface or it silently does nothing at all.
//
//   1. A `/reader?overlay=…` href is claimed in place ONLY where the overlay it
//      names is actually mounted. Eight of the eleven live in `WorkspaceView`
//      alone, so off the workspace claiming one sets store state no renderer is
//      listening to — and the caller, believing it handled, skips the push that
//      would have worked.
//   2. A post opens in the reader pane inside the workspace and at its
//      standalone route outside it — never a bare `router.push` from an
//      overlay body, which is the escape ban.
//
// The third suite is the standing grep for (2), the same shape as
// `href-guard.test.ts`: fixing four call sites leaves the fifth somebody adds.
// =============================================================================

type PostOverrides = Omit<Partial<Post>, "origin"> & {
  origin?: Partial<Post["origin"]>;
};

function post(over: PostOverrides = {}): Post {
  const { origin, ...rest } = over;
  return {
    id: "p1",
    author: { pubkey: null },
    body: { title: "A piece", summary: null },
    ...rest,
    origin: {
      protocol: "rss",
      // The shape the whole fix is about: an RSS guid that is a perfectly
      // conformant identity and not a URL.
      uri: "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      webUrl: null,
      sourceName: "The Example",
      publication: null,
      ...(origin ?? {}),
    },
  } as unknown as Post;
}

beforeEach(() => {
  useWorkspaceSurface.setState({ mounted: false });
  useMessagesOverlay.setState({ isOpen: false, conversationId: null });
  useSettingsOverlay.getState().close();
  useProfile.getState().dismiss?.();
  useAuth.setState({ user: null, loading: false });
  // setState rather than close(): the reader's own close() runs history.back().
  useReader.setState({ isOpen: false, target: null, nav: null });
});

describe("routeToOverlay only claims an overlay that is mounted", () => {
  it("declines a workspace-only overlay off the workspace, so the caller navigates", () => {
    expect(routeToOverlay("/reader?overlay=messages&conversation=c1")).toBe(
      false,
    );
    expect(useMessagesOverlay.getState().isOpen).toBe(false);
  });

  it("claims it — and seeds it — while the workspace is mounted", () => {
    useWorkspaceSurface.setState({ mounted: true });
    expect(routeToOverlay("/reader?overlay=messages&conversation=c1")).toBe(
      true,
    );
    expect(useMessagesOverlay.getState().isOpen).toBe(true);
    expect(useMessagesOverlay.getState().conversationId).toBe("c1");
  });

  it("covers the other workspace-only panels, not just messages", () => {
    expect(routeToOverlay("/reader?overlay=settings")).toBe(false);
    expect(useSettingsOverlay.getState().isOpen).toBe(false);
    useWorkspaceSurface.setState({ mounted: true });
    expect(routeToOverlay("/reader?overlay=settings")).toBe(true);
  });

  it("still claims a GLOBALLY mounted overlay off the workspace", () => {
    // `ProfileOverlay` is mounted by `LayoutShell`, so a profile href opens in
    // place on a standalone page too — the gate is about where the component
    // is, not about tidiness.
    expect(routeToOverlay("/reader?overlay=profile&user=alice")).toBe(true);
  });

  // ---------------------------------------------------------------------
  // `user=me` — the sentinel the retired /network shim mints, because a server
  // redirect reads no session and cannot name a username.
  // ---------------------------------------------------------------------

  it("resolves user=me against the signed-in member, not a writer called me", () => {
    useAuth.setState({
      user: { username: "alice" } as never,
      loading: false,
    });
    expect(routeToOverlay("/reader?overlay=profile&user=me")).toBe(true);
    expect(useProfile.getState().target).toEqual({
      kind: "native",
      username: "alice",
    });
  });

  it("declines user=me for a settled anonymous visitor", () => {
    expect(routeToOverlay("/reader?overlay=profile&user=me")).toBe(false);
    expect(useProfile.getState().isOpen).toBe(false);
  });

  it("waits for a session that has not landed yet, then opens it", () => {
    // The workspace dispatches deep links in a MOUNT effect, and the session is
    // an httpOnly cookie only fetchMe() can see — so /network regularly asks
    // for "me" a round-trip before the answer exists. Claiming the href and
    // then dropping it would be the silent-nothing failure this suite is about.
    useAuth.setState({ user: null, loading: true });
    expect(routeToOverlay("/reader?overlay=profile&user=me")).toBe(true);
    expect(useProfile.getState().isOpen).toBe(false);

    useAuth.setState({ user: { username: "bob" } as never, loading: false });
    expect(useProfile.getState().target).toEqual({
      kind: "native",
      username: "bob",
    });
  });

  it("stops listening once it has opened, so a later login opens nothing", () => {
    useAuth.setState({ user: null, loading: true });
    routeToOverlay("/reader?overlay=profile&user=me");
    useAuth.setState({ user: { username: "bob" } as never, loading: false });
    useProfile.getState().dismiss();

    // A second identity settling must not resurrect a pane nobody asked for.
    useAuth.setState({ user: { username: "carol" } as never, loading: false });
    expect(useProfile.getState().isOpen).toBe(false);
  });

  it("carries the VIEW a retired address named, through the wait as well", () => {
    // `/following` and `/social` were views of the Network page, not pages —
    // they are two of `WriterActivity`'s five. The pane deliberately ignores
    // the ambient workspace `?tab` (the address belongs to the workspace), so
    // without a seed both shims land on the profile's FRONT DOOR and silently
    // drop the thing the link was about.
    useAuth.setState({ user: { username: "alice" } as never, loading: false });
    expect(routeToOverlay("/reader?overlay=profile&user=me&tab=following")).toBe(
      true,
    );
    expect(useProfile.getState().tab).toBe("following");

    // And a named user, not just the sentinel.
    useProfile.getState().dismiss();
    routeToOverlay("/reader?overlay=profile&user=bob&tab=followers");
    expect(useProfile.getState().target).toEqual({
      kind: "native",
      username: "bob",
    });
    expect(useProfile.getState().tab).toBe("followers");

    // The deferred path is where a seed is easiest to lose: `openSelf` opens
    // from inside a subscription callback, one turn after the caller's frame.
    useProfile.getState().dismiss();
    useAuth.setState({ user: null, loading: true });
    routeToOverlay("/reader?overlay=profile&user=me&tab=following");
    useAuth.setState({ user: { username: "bob" } as never, loading: false });
    expect(useProfile.getState().tab).toBe("following");

    // No tab named is no tab seeded — the front door stays the default.
    useProfile.getState().dismiss();
    useAuth.setState({ user: { username: "alice" } as never, loading: false });
    routeToOverlay("/reader?overlay=profile&user=me");
    expect(useProfile.getState().tab).toBeNull();
  });

  it("claims a READING route too, so a notification row cannot escape", () => {
    // `/article/:dTag` and `/read/:postId` carry no `?overlay=`, so they fell
    // through to the caller's `router.push` — a full navigation out of the
    // workspace, which is the escape ban's own example. Every notification
    // row with an article behind it (`new_reply`, `new_mention`, `new_quote`,
    // `pub_*`, `tribute_*`) took that path.
    useWorkspaceSurface.setState({ mounted: true });
    expect(routeToOverlay("/article/a-piece")).toBe(true);
    expect(useReader.getState().isOpen).toBe(true);

    // The `#reply-…` hash a reply notification carries is not part of the
    // d-tag — the pane opens the piece, which is the destination.
    useReader.setState({ isOpen: false });
    expect(routeToOverlay("/article/a-piece#reply-123")).toBe(true);
    expect(useReader.getState().isOpen).toBe(true);
  });

  it("does NOT claim a reading route off the workspace — the push is right there", () => {
    // `ReaderOverlay` is mounted by `WorkspaceView` alone, so claiming it on a
    // standalone page would swallow the navigation that actually works. Same
    // mount gate, same reason, as the eight workspace-only overlays.
    useWorkspaceSurface.setState({ mounted: false });
    useReader.setState({ isOpen: false });
    expect(routeToOverlay("/article/a-piece")).toBe(false);
    expect(useReader.getState().isOpen).toBe(false);
  });

  it("is not fooled by an href that names no overlay", () => {
    expect(routeToOverlay("/reader?foo=1")).toBe(false);
    expect(routeToOverlay("/reader")).toBe(false);
    expect(routeToOverlay("/somewhere?overlay=messages")).toBe(false);
  });
});

describe("openPostInReader", () => {
  it("does not open an external post whose only origin is a non-URL RSS guid", () => {
    const p = post();
    expect(canOpenPostInReader(p)).toBe(false);
    const router = { push: vi.fn() };
    useWorkspaceSurface.setState({ mounted: true });
    openPostInReader(p, router);
    expect(router.push).not.toHaveBeenCalled();
    expect(useReader.getState().isOpen).toBe(false);
  });

  it("opens the ingester's canonical url when the guid is not one", () => {
    const p = post({ origin: { webUrl: "https://example.com/a-piece" } });
    expect(canOpenPostInReader(p)).toBe(true);
    useWorkspaceSurface.setState({ mounted: true });
    openPostInReader(p, { push: vi.fn() });
    const target = useReader.getState().target;
    expect(target?.kind).toBe("external");
    expect(target && "url" in target ? target.url : null).toBe(
      "https://example.com/a-piece",
    );
  });

  it("navigates instead of opening a pane when the workspace is not mounted", () => {
    const p = post({ origin: { webUrl: "https://example.com/a-piece" } });
    const router = { push: vi.fn() };
    openPostInReader(p, router);
    expect(useReader.getState().isOpen).toBe(false);
    expect(router.push).toHaveBeenCalledWith("/read/p1");
  });

  it("takes a native article to its d-tag, both ways", () => {
    const p = post({
      author: { pubkey: "abc" } as Post["author"],
      dTag: "my-piece",
      origin: { protocol: "nostr", uri: "eventid", webUrl: null },
    });
    const router = { push: vi.fn() };
    openPostInReader(p, router);
    expect(router.push).toHaveBeenCalledWith("/article/my-piece");

    useWorkspaceSurface.setState({ mounted: true });
    openPostInReader(p, router);
    const target = useReader.getState().target;
    expect(target?.kind).toBe("native");
    expect(target && "dTag" in target ? target.dTag : null).toBe("my-piece");
  });
});

// ---------------------------------------------------------------------------
// The standing grep. A comment cannot fail; this can.
// ---------------------------------------------------------------------------

const ROOTS = [
  path.resolve(__dirname, "..", "src", "components"),
  path.resolve(__dirname, "..", "src", "app"),
];

// Files allowed to push a reading route, each with the reason. A NEW one fails
// until somebody writes its line — which is the moment to ask whether the
// surface it is on can be reached from the workspace.
const ALLOWED = new Map<string, string>([
  [
    "components/library/LibraryPanel.tsx",
    "already branches on its own inOverlay seam (openArticle)",
  ],
  [
    "app/tag/[tag]/TagBrowser.tsx",
    "already branches on its own inOverlay seam",
  ],
  [
    "lib/workspace/open-post.ts",
    "the one home — this IS the standalone-route branch",
  ],
  [
    "components/tribute/TributeClaimResumer.tsx",
    "headless post-login resumer: a whole-route navigation is the intent, and it never runs inside an overlay body",
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("no workspace-reachable surface pushes a reading route", () => {
  const files = ROOTS.flatMap(sourceFiles);

  it("finds the trees it is meant to be scanning", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("routes every article/read open through openPostInReader", () => {
    const offenders: string[] = [];
    const PUSH = /(?:router|useRouter\(\))\.(?:push|replace)\(\s*[`'"]\/(?:article|read)\//g;
    for (const file of files) {
      const rel = path
        .relative(path.resolve(__dirname, "..", "src"), file)
        .split(path.sep)
        .join("/");
      if (ALLOWED.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(PUSH)) {
        offenders.push(
          `${rel}:${source.slice(0, m.index).split("\n").length} — ${m[0]}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// A notification row names a PERSON or a PAGE, and the two open differently.
//
// Reported from the outside: "someone @s me in a note, I click the
// notification, and the page that renders is their profile at the native URL"
// — a full navigation out of the workspace, for the one destination the site
// has drawn as a pane everywhere else since `ProfileLink` shipped.
//
// The panel could not obey that rule while its destination was a bare string,
// and the first test below is why: `profileTargetFromHref` is deliberately
// greedy (it is handed hrefs already known to be profiles), so asking it after
// the fact whether a destination is a person answers YES for `/article/abc`.
// The kind is known at the branch that built the href and nowhere else, so
// `getDest` carries it.
//
// Mutation-proved: returning `page(...)` where `getDest` returns `person(...)`
// fails 2; re-deriving the kind from the href instead of carrying it fails 3,
// the first of them by name. What is NOT pinned here is the handoff itself —
// that the inbox is left standing for the profile's mount effect to supersede,
// rather than closed on the click — because the proof of that is frames on a
// live pane and not a return value (the handoff rule says so in as many words).
// It was driven in a browser instead; see FIX-PROGRAMME.
// =============================================================================

import {
  getDest,
  type Dest,
} from "../src/lib/notifications/dest";
import {
  profileTargetFromHref,
  openProfileHref,
} from "../src/components/ui/ProfileLink";

type Notif = Parameters<typeof getDest>[0];

function notif(over: Record<string, unknown>): Notif {
  return {
    id: "n1",
    read: false,
    createdAt: new Date().toISOString(),
    actor: { username: "mira-h", displayName: "Mira H", avatar: null },
    ...over,
  } as unknown as Notif;
}

describe("a notification destination knows what it names", () => {
  it("an article is not a person, however the matcher reads it", () => {
    // The trap, stated out loud: this is what re-deriving the kind would do.
    expect(profileTargetFromHref("/article/abc")).toEqual({
      kind: "native",
      username: "article",
    });
    // …and this is why `getDest` carries the kind instead.
    expect(getDest(notif({ type: "new_mention", article: { slug: "abc" } })))
      .toEqual({ kind: "url", href: "/article/abc" });
  });

  it("a note-based mention names the person who wrote it", () => {
    expect(getDest(notif({ type: "new_mention" }))).toEqual({
      kind: "profile",
      href: "/mira-h",
      focus: null,
    });
  });

  it.each([
    "new_follower",
    "new_subscriber",
    "new_quote",
    "new_reply",
    "pub_new_subscriber",
    "pub_member_joined",
    "pub_member_left",
  ])("%s with no piece behind it names a person", (type) => {
    expect(getDest(notif({ type }))).toEqual({
      kind: "profile",
      href: "/mira-h",
      focus: null,
    });
  });

  it("a revoked gift falls back to the writer, still as a person", () => {
    expect(getDest(notif({ type: "subscription_offer" }))).toEqual({
      kind: "profile",
      href: "/mira-h",
      focus: null,
    });
    expect(
      getDest(notif({ type: "subscription_offer", offer: { code: "abc123" } })),
    ).toEqual({ kind: "url", href: "/subscribe/abc123" });
  });

  it("a destination with no actor and no piece is nowhere, not a bare slash", () => {
    const dest: Dest = getDest(notif({ type: "new_follower", actor: null }));
    expect(dest).toEqual({ kind: "none" });
  });

  it("an overlay deep link stays a url, so routeToOverlay still gets it", () => {
    expect(getDest(notif({ type: "pub_invite_received" }))).toEqual({
      kind: "url",
      href: "/reader?overlay=dashboard",
    });
  });

  it("a note-based mention opens the profile ON the note", () => {
    const focus = { postId: "p-abc", view: "posts" as const };
    expect(getDest(notif({ type: "new_mention", focus }))).toEqual({
      kind: "profile",
      href: "/mira-h",
      focus,
    });
  });

  it("a mention written in a comment opens on the REPLIES view", () => {
    const focus = { postId: "p-def", view: "replies" as const };
    expect(getDest(notif({ type: "new_reply", focus }))).toEqual({
      kind: "profile",
      href: "/mira-h",
      focus,
    });
  });

  it("a follow opens the front door even if a focus is on the wire", () => {
    // `person()` is handed a focus only by the branches that are about a piece
    // of writing. A follow is about the FOLLOW, so a stray focus — an older
    // row, a wider server — must not send the pane somewhere it was not asked
    // to go. The drop is at the branch, not at the server.
    const dest = getDest(
      notif({
        type: "new_follower",
        focus: { postId: "p-ghi", view: "posts" as const },
      }),
    );
    expect(dest).toEqual({ kind: "profile", href: "/mira-h", focus: null });
  });

  it("opening a person's href sets the profile pane, with no entry box off a pane", () => {
    useProfile.setState({ isOpen: false, target: null, enterFrom: null });
    expect(openProfileHref("/mira-h")).toBe(true);
    const s = useProfile.getState();
    expect(s.isOpen).toBe(true);
    expect(s.target).toEqual({ kind: "native", username: "mira-h" });
    expect(s.focus).toBeNull();
    expect(s.returnTo).toBeNull();
    // Nothing was open, so there is no box to grow out of — the arrival off the
    // bare floor is unchanged by the handoff work.
    expect(s.enterFrom).toBeNull();
  });
});

// =============================================================================
// The inbox comes back if it still has anything to say.
//
// The handoff rule means the notifications inbox is SUPERSEDED rather than
// closed on the way into a profile, so nothing but the profile's own close can
// put it back — and whether it should is a question about the moment of
// return, not the moment of departure: clicking a row marks it read, so a
// reader who has just opened their last unread notification should land on the
// workspace, and one with more to get through should land back on the list.
//
// Mutation-proved four ways: dropping the destination gate fails BOTH the
// departing-link test and the supersede test; reading the count at open
// instead of at close fails "the last one leaves nothing behind"; dropping the
// `returnTo` guard fails "a profile opened from anywhere else"; restoring in
// `close` as well as in `_handlePop` fails the delegation test; and reverting
// `dismiss` to a bare clear fails the first test in the block.
// =============================================================================

describe("returning from a profile opened by a notification", () => {
  beforeEach(() => {
    // The restore is gated on landing back on the workspace, so the fixture
    // has to stand there — jsdom's default is "/".
    window.history.replaceState({}, "", "/reader");
    useMessagesOverlay.setState({ isOpen: false, conversationId: null });
    useUnreadCounts.setState({ dmCount: 0, notificationCount: 0 });
    useProfile.setState({ isOpen: false, target: null, returnTo: null });
  });

  function openFromInbox(unread: number) {
    useUnreadCounts.setState({ notificationCount: unread });
    useProfile.getState().openNative("mira-h", { returnTo: "messages" });
  }

  /** What the browser does on Back: the address returns to where the reader
   *  came from FIRST, and the pane's exit runs against that. Calling the exit
   *  while the URL still reads /mira-h would test a moment that never happens
   *  and would make the destination gate untestable. */
  function goBackTo(path: string, exit: "dismiss" | "_handlePop") {
    window.history.replaceState({}, "", path);
    useProfile.getState()[exit]();
  }

  // Back arrives through `dismiss`, not `_handlePop`, and that was measured
  // rather than assumed — Next's own popstate listener is registered first, so
  // its re-render runs `ProfileOverlay`'s pathname effect before our listener
  // is reached. Both exits are tested, because neither may assume it is the
  // one that ran.
  it("puts the inbox back when unread notifications remain", () => {
    openFromInbox(3);
    goBackTo("/reader", "dismiss");
    expect(useMessagesOverlay.getState().isOpen).toBe(true);
    expect(useProfile.getState().isOpen).toBe(false);
  });

  it("and again through the popstate exit, if that is the one that wins", () => {
    openFromInbox(3);
    goBackTo("/reader", "_handlePop");
    expect(useMessagesOverlay.getState().isOpen).toBe(true);
  });

  it("the ✕ delegates to the pop path rather than finalising twice", () => {
    openFromInbox(3);
    // `openNative` claimed the entry, so there IS one to pop: close hands over
    // and changes nothing itself. Restoring here as well would open the inbox
    // on a history entry that is still on its way out.
    useProfile.getState().close();
    expect(useProfile.getState().isOpen).toBe(true);
    expect(useMessagesOverlay.getState().isOpen).toBe(false);
  });

  it("closes directly when there is no entry to pop", () => {
    // The degraded case `claimOverlayEntry` documents — a history quota or an
    // opaque origin leaves the pane un-addressed. It must still close, and
    // still put the inbox back.
    openFromInbox(3);
    window.history.replaceState({}, "", "/reader");
    useProfile.getState().close();
    expect(useProfile.getState().isOpen).toBe(false);
    expect(useMessagesOverlay.getState().isOpen).toBe(true);
  });

  it("the last one leaves nothing behind", () => {
    // Opened while one was unread, and the click marked it read: what decides
    // is the count NOW, which is why it is read at close and not remembered
    // from the way in.
    openFromInbox(1);
    useUnreadCounts.setState({ notificationCount: 0 });
    goBackTo("/reader", "dismiss");
    expect(useMessagesOverlay.getState().isOpen).toBe(false);
  });

  it("a supersede restores nothing, and the destination is why", () => {
    // Something else is taking the pane's place, and putting the inbox back
    // would drop it UNDER the newcomer. What refuses it is not a separate
    // exit — one was written and removed, because no test could tell it from
    // `dismiss` — but the fact that a profile pane only ever exists at its own
    // /<username>, so a supersede never happens while standing on /reader.
    // The address here is the profile's, exactly as it is in the app.
    openFromInbox(5);
    expect(window.location.pathname).toBe("/mira-h");
    useProfile.getState().dismiss();
    expect(useMessagesOverlay.getState().isOpen).toBe(false);
  });

  it("a link inside the pane leaving the workspace restores nothing", () => {
    // Same exit as Back, different destination. The inbox is mounted by the
    // workspace alone, so opening it here would set state nothing renders —
    // and then spring the pane open unasked on the reader's next visit.
    openFromInbox(2);
    goBackTo("/article/some-piece", "dismiss");
    expect(useMessagesOverlay.getState().isOpen).toBe(false);
  });

  it("a profile opened from anywhere else restores nothing", () => {
    useUnreadCounts.setState({ notificationCount: 5 });
    useProfile.getState().openNative("mira-h");
    goBackTo("/reader", "dismiss");
    expect(useMessagesOverlay.getState().isOpen).toBe(false);
  });

  it("the errand does not outlive the pane", () => {
    openFromInbox(3);
    goBackTo("/reader", "dismiss");
    expect(useProfile.getState().returnTo).toBeNull();
    expect(useProfile.getState().focus).toBeNull();
  });
});

// =============================================================================
// A pane that superseded a URL-synced one hands it back.
//
// Reported the long way round: reply to a mention from the pinned conversation
// and the conversation you were reading is gone, along with the reply you just
// wrote. The composer is a Glasshouse, so it supersedes the profile pane and
// leaves its URL standing — close it and the address reads `/celiaspencer`
// while the reader is looking at the workspace. Driven before it was fixed:
// after publishing, zero cards in the pane and the address unchanged.
//
// The `overlayEntryIsCurrent()` guard is the whole safety of the last branch:
// a bare `/<segment>` is read as a username only because the history marker
// says an overlay put it there — which is precisely the check the greedy
// `profileTargetFromHref` cannot make for itself.
//
// Mutation-proved: dropping the marker guard fails "a page nobody claimed";
// dropping the already-open guard fails "one at a time".
// =============================================================================

import { reopenAddressedPane } from "../src/lib/workspace/overlays";
import { useSurfaceOverlay } from "../src/stores/surfaceOverlay";

describe("reopening the pane the address still names", () => {
  beforeEach(() => {
    useProfile.setState({ isOpen: false, target: null });
    useReader.setState({ isOpen: false });
    useSurfaceOverlay.setState({ isOpen: false, target: null });
  });

  /** An address an overlay claimed, marker and all. */
  function claimed(path: string) {
    window.history.replaceState({ allhausOverlay: true }, "", path);
  }

  it("a superseded pane is RESUMED, carrying its errand", () => {
    // What replying from the pinned conversation does: the composer takes the
    // screen without claiming a URL, so the address still names the profile.
    // Rebuilding from the address alone loses the errand and lands the reader
    // on ARTICLES — driven, before this was a resume.
    const focus = { postId: "p-abc", view: "posts" as const };
    window.history.replaceState({ allhausOverlay: true }, "", "/mira-h");
    useProfile.getState().openNative("mira-h", {
      focus,
      returnTo: "messages",
    });
    useProfile.getState().dismiss();
    expect(useProfile.getState().isOpen).toBe(false);
    // Suspended, not cleared: the identity has to survive for the handover.
    expect(useProfile.getState().focus).toEqual(focus);

    expect(reopenAddressedPane()).toBe(true);
    const s = useProfile.getState();
    expect(s.isOpen).toBe(true);
    expect(s.focus).toEqual(focus);
    expect(s.returnTo).toBe("messages");
  });

  it("a pane the route has LEFT is cleared, not suspended", () => {
    useProfile.getState().openNative("mira-h", { focus: { postId: "p", view: "posts" } });
    window.history.replaceState({}, "", "/article/some-piece");
    useProfile.getState().dismiss();
    expect(useProfile.getState().target).toBeNull();
    expect(useProfile.getState().focus).toBeNull();
  });

  it("a bare username reopens the profile", () => {
    claimed("/mira-h");
    expect(reopenAddressedPane()).toBe(true);
    expect(useProfile.getState().target).toEqual({
      kind: "native",
      username: "mira-h",
    });
  });

  it("an /author id reopens the external profile", () => {
    claimed("/author/abc-123");
    expect(reopenAddressedPane()).toBe(true);
    expect(useProfile.getState().target).toEqual({
      kind: "external",
      authorId: "abc-123",
    });
  });

  it("an /article d-tag reopens the reader", () => {
    claimed("/article/mira-h-a-piece");
    expect(reopenAddressedPane()).toBe(true);
    expect(useReader.getState().isOpen).toBe(true);
  });

  it("a page nobody claimed is left alone", () => {
    // No marker: this is somewhere the reader actually navigated to, and
    // reopening a pane over it would be inventing one.
    window.history.replaceState({}, "", "/mira-h");
    expect(reopenAddressedPane()).toBe(false);
    expect(useProfile.getState().isOpen).toBe(false);
  });

  it("one at a time — a pane already up owns the address", () => {
    claimed("/mira-h");
    useReader.setState({ isOpen: true });
    expect(reopenAddressedPane()).toBe(false);
    expect(useProfile.getState().isOpen).toBe(false);
  });

  it("the workspace's own address names no pane", () => {
    claimed("/reader");
    // `/reader` is a single bare segment, so this is the case the username
    // branch would swallow if it ran before the guard above — it does not,
    // because the workspace never claims an overlay entry. Asserted anyway:
    // the branch is one edit away from being reached.
    reopenAddressedPane();
    expect(useProfile.getState().target).not.toEqual({
      kind: "native",
      username: "reader",
    });
  });
});
