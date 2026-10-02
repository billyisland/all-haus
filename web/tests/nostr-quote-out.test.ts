import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noteEventParts, type NoteSignature } from "../src/lib/note-compose";
import { quoteTargetFromPost } from "../src/lib/post/quote-target";
import type { Post } from "../src/lib/post/types";

// =============================================================================
// A QUOTE OF AN EXTERNAL NOSTR POST IS A NIP-18 QUOTE, AND IT GOES OUT (CA-I13).
//
// An external post is quoted by its POST ID, and the note used to carry no `q`
// tag and no signed event — so the gateway's replay onto the quoted post's
// relays could never run, and the note would have reached them as a bare link
// if it had. The gateway's Post now carries the item's own event
// (`origin.nostrEvent`); the quote target keeps it, the note q-tags it, and the
// index body sends the signed event. The server half — resolve by post id,
// replay only the author's own verified note — is
// gateway/tests/nostr-quote-out.test.ts.
// =============================================================================

const EVENT = { id: "e".repeat(64), pubkey: "d".repeat(64) };
const SIG: NoteSignature = { id: "f".repeat(64), pubkey: "a".repeat(64), sig: "s".repeat(128), created_at: 1_700_000_000 };

function externalPost(nostrEvent: typeof EVENT | null, protocol = "nostr_external"): Post {
  return {
    id: "p".repeat(64),
    version: null,
    type: "note",
    origin: { protocol, uri: "nevent1x", webUrl: "https://njump.me/nevent1x", sourceName: "Somebody", publication: null, nostrEvent },
    author: { id: "x1", accountId: null, displayName: "Somebody", handle: null, handleUri: null, pubkey: null, pipStatus: "unknown" },
    body: { text: "the quoted words", html: null, title: null, summary: null, media: [], contentWarning: null, poll: null },
  } as unknown as Post;
}

describe("quoting an external Nostr post", () => {
  it("the quote target keeps the post's own event", () => {
    const t = quoteTargetFromPost(externalPost(EVENT));
    expect(t.isExternal).toBe(true);
    expect(t.nostrEvent).toEqual(EVENT);
  });

  it("the note q-tags it and the index body carries the whole signed event", () => {
    const parts = noteEventParts("worth reading", quoteTargetFromPost(externalPost(EVENT)));
    expect(parts.tags).toContainEqual(["q", EVENT.id, "", EVENT.pubkey]);
    const body = parts.indexBody(SIG.id, SIG);
    expect(body.signedEvent).toEqual({ kind: 1, content: parts.content, tags: parts.tags, ...SIG });
    // Still an external quote: the snapshot and the post id travel as before.
    expect(body.quotedPostId).toBe("p".repeat(64));
  });

  it("any other external quote carries neither — nothing to q-tag, nothing to replay", () => {
    const parts = noteEventParts("worth reading", quoteTargetFromPost(externalPost(null, "atproto")));
    expect(parts.tags.some((t) => t[0] === "q")).toBe(false);
    expect(parts.indexBody(SIG.id, SIG).signedEvent).toBeUndefined();
  });
});

describe("origin.nostrEvent on the wire", () => {
  it("the gateway mapper sends it, from interaction_data, for nostr_external alone", () => {
    const mapper = readFileSync(join(__dirname, "../../gateway/src/lib/post-mapper.ts"), "utf8");
    expect(mapper).toMatch(/nostrEvent\?: \{ id: string; pubkey: string \} \| null;/);
    expect(mapper).toMatch(/nostrEvent: externalNostrEvent\(row\.source_protocol, row\.ei_interaction_data\)/);
    expect(mapper).toMatch(/if \(protocol !== "nostr_external" \|\| !data\) return null;/);
  });

  it("the web type declares it", () => {
    const types = readFileSync(join(__dirname, "../src/lib/post/types.ts"), "utf8");
    expect(types).toMatch(/nostrEvent\?: \{ id: string; pubkey: string \} \| null;/);
  });
});
