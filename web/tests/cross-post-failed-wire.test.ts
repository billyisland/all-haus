import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getDest } from "../src/lib/notifications/dest";
import type { Notification } from "../src/lib/api/notifications";

// =============================================================================
// A FAILED CROSS-POST IS TOLD TO THE MEMBER, ACROSS THREE WORKSPACES
// (CROSS-NETWORK-ROUNDTRIP-ADR A7).
//
// The notification TYPE is minted by the feed-ingest worker, the list of
// failed networks is attached by the gateway's notifications route, and the
// sentence is chosen by this panel — three files, no module path between
// them, and `tsc` content with a client union holding a type nobody sends. A
// renamed string anywhere makes the row fall through to "sent you a
// notification" from yourself. So each string is PINNED by reading the file
// that owns it, and each pin asserts its match was FOUND.
//
// The same for the reply route's `crossPost` answer, which the inline reply
// box compares against a literal.
// =============================================================================

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("cross_post_failed on the wire", () => {
  it("the worker mints the type the panel renders", () => {
    const worker = read("feed-ingest/src/tasks/outbound-cross-post.ts");
    const minted = worker.match(/SELECT op\.account_id, op\.account_id, '([a-z_]+)', n\.id/);
    expect(minted).not.toBeNull();
    expect(minted![1]).toBe("cross_post_failed");

    const panel = read("web/src/components/notifications/NotificationsPanel.tsx");
    expect(read("web/src/lib/notifications/dest.ts")).toContain(`case '${minted![1]}':`);
    expect(panel).toContain(`n.type === '${minted![1]}'`);
    expect(read("web/src/lib/api/notifications.ts")).toContain(`| '${minted![1]}'`);
  });

  it("the gateway attaches crossPostFailures to exactly that type", () => {
    const route = read("gateway/src/routes/notifications.ts");
    const m = route.match(/r\.type === '([a-z_]+)'\s*\n?\s*\?\s*\{\s*(\w+):/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("cross_post_failed");
    expect(m![2]).toBe("crossPostFailures");
    // …with the protocol/error pair the panel reads.
    expect(route).toMatch(/'protocol', op\.protocol,\s*'error',/);
  });

  it("opens the member's own profile on the note", () => {
    const n = {
      id: "n1",
      type: "cross_post_failed",
      read: false,
      createdAt: new Date().toISOString(),
      actor: { id: "me", username: "me", displayName: "Me", avatar: null },
      article: null,
      note: { id: "note", nostrEventId: "e".repeat(64) },
      comment: null,
      parentComment: null,
      publication: null,
      focus: { postId: "p".repeat(64), view: "posts" },
      crossPostFailures: [{ protocol: "atproto", error: "Reconnect" }],
    } as Notification;
    expect(getDest(n)).toEqual({
      kind: "profile",
      href: "/me",
      focus: { postId: "p".repeat(64), view: "posts" },
    });
  });
});

describe("the reply route's crossPost answer", () => {
  it("the value the inline reply box tests for is one the route sends", () => {
    const route = read("gateway/src/routes/external-items/interactions.ts");
    const union = route.match(/let crossPost: ("[a-z_]+")(?: \| ("[a-z_]+"))*/);
    expect(union).not.toBeNull();
    const sent = route.match(/crossPost = "([a-z_]+)";/);
    expect(sent).not.toBeNull();
    expect(sent![1]).toBe("not_sent");
    expect(read("web/src/components/workspace/InlineReplyBox.tsx")).toContain(
      `res.crossPost === "${sent![1]}"`,
    );
  });
});
