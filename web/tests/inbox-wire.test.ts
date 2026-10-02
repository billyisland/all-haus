import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// =============================================================================
// THE INBOX ROW IS WHAT `GET /messages` SENDS (MODERNHAUS-ADR §E6.3).
//
// The full site's conversation list read `conv.lastMessage.content` and its
// time, and `listInbox` has never sent a `lastMessage` — it sends
// `lastMessageAt` and `createdAt`, and no preview (one would be a decrypt per
// row). `tsc` was content with the web's hand-written interface, so the list
// showed neither a preview nor a time, with nothing anywhere saying so. The two
// field lists are read out of the files that own them and must be the same set.
// =============================================================================

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** The top-level field names of `interface <name> { … }` in `src`. */
function fields(src: string, name: string): string[] {
  const m = src.match(new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(m, `interface ${name}`).not.toBeNull();
  return [...m![1].matchAll(/^ {2}(\w+)\??:/gm)].map((f) => f[1]).sort();
}

describe("the inbox row on the wire", () => {
  it("the web's Conversation has exactly the gateway's InboxConversation fields", () => {
    const gateway = fields(read("gateway/src/services/messages.ts"), "InboxConversation");
    expect(gateway).toContain("lastMessageAt");
    expect(fields(read("web/src/lib/api/messages.ts"), "Conversation")).toEqual(gateway);
  });

  it("the list shows the row's time from the fields the route sends", () => {
    const list = read("web/src/components/messages/ConversationList.tsx");
    expect(list).toContain("timeAgo(conv.lastMessageAt ?? conv.createdAt");
    expect(list).not.toContain("lastMessage.");
  });
});
