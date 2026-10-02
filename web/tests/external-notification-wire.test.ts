import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getDest } from "../src/lib/notifications/dest";
import type { Notification } from "../src/lib/api/notifications";

// =============================================================================
// REPLIES FROM ELSEWHERE, ACROSS THREE WORKSPACES (CROSS-NETWORK-ROUNDTRIP-ADR
// rung C).
//
// The three types are minted by feed-ingest's poller, the external post is
// attached by the gateway's notifications route, and the sentence and the
// destination are chosen by this panel. No module path joins them and `tsc` is
// content with a client union naming types nobody sends, so each string is
// PINNED by reading the file that owns it — and each pin asserts its match was
// FOUND, or a rename would pass by testing nothing.
// =============================================================================

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("the external notification types on the wire", () => {
  const worker = read("feed-ingest/src/tasks/linked-notifications-poll.ts");
  const minted = [...worker.matchAll(/\?\s*"(external_[a-z]+)"/g)].map((m) => m[1]);

  it("the poller mints exactly three, and the client and panel know each", () => {
    // The kind is chosen in two places (Bluesky's reason, Mastodon's type);
    // the union of what they mint is the vocabulary.
    const kinds = [...new Set(minted)].sort();
    expect(kinds).toEqual(["external_mention", "external_quote", "external_reply"]);
    const client = read("web/src/lib/api/notifications.ts");
    const dest = read("web/src/lib/notifications/dest.ts");
    const copy = read("web/src/content/notifications.ts");
    for (const k of kinds) {
      expect(client).toContain(`| '${k}'`);
      expect(dest).toContain(`case '${k}':`);
      expect(copy).toMatch(new RegExp(`\\b${k}: '`));
    }
  });

  it("the gateway attaches `external` with the fields the panel reads", () => {
    const route = read("gateway/src/routes/notifications.ts");
    const block = route.match(/external: r\.external_item_id\s*\?\s*\{([\s\S]*?)\}\s*:\s*null/);
    expect(block).not.toBeNull();
    const fields = [...block![1].matchAll(/(\w+):/g)].map((m) => m[1]).sort();
    expect(fields).toEqual(
      ["authorAvatar", "authorHandle", "authorId", "authorName", "excerpt", "itemId", "protocol"].sort(),
    );
  });
});

describe("where an external notification opens", () => {
  const base = {
    id: "n1",
    read: false,
    createdAt: new Date().toISOString(),
    actor: null,
    article: null,
    comment: null,
    parentComment: null,
    publication: null,
    external: {
      itemId: "ei",
      protocol: "atproto",
      authorName: "Stranger",
      authorHandle: "stranger.bsky.social",
      authorAvatar: null,
      authorId: "xa-uuid",
      excerpt: "hi",
    },
  };

  it("a reply to the reader's cross-post opens their OWN profile on that note", () => {
    const n = {
      ...base,
      type: "external_reply",
      note: { id: "note", nostrEventId: "e".repeat(64) },
      focus: { postId: "p".repeat(64), view: "posts" },
    } as Notification;
    expect(getDest(n, "me")).toEqual({
      kind: "profile",
      href: "/me",
      focus: { postId: "p".repeat(64), view: "posts" },
    });
  });

  it("a bare mention opens the person who wrote it", () => {
    const n = { ...base, type: "external_mention", note: null, focus: null } as Notification;
    expect(getDest(n, "me")).toEqual({ kind: "profile", href: "/author/xa-uuid", focus: null });
  });
});
