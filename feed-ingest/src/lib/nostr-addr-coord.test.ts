import { describe, it, expect } from "vitest";
import { nip19 } from "nostr-tools";
import {
  applyNostrDeletions,
  detectNostrRepost,
  parseNostrAddrCoord,
  type NostrEvent,
  type Queryable,
} from "./nostr-ingest.js";

// =============================================================================
// An `a` coordinate is `<kind>:<pubkey>:<d-identifier>`, and NIP-01 puts no
// character class on the identifier — a colon in it is ordinary.
//
// THE DEFECT THIS PINS was a second spelling of the parse. `detectNostrRepost`
// spread the remainder and rejoined it; `applyNostrDeletions` destructured three
// values and dropped everything after the second colon. So a kind-5 naming
// `30023:<pk>:on-writing:part-two` built the naddr for `on-writing`, matched no
// row, and the author's retraction was silently discarded — the piece stayed
// live and the ingest reported success. Nothing errored, which is why it lasted.
//
// The claim under test is therefore NOT "the helper splits correctly" — a test
// of `parseNostrAddrCoord` alone would agree with its own copy of the rule.
// It is that the two READERS of an `a` tag now produce the same identity for the
// same coordinate, driven through the real functions, with the colon-free case
// beside it as the control that says the assertion is about the colon.
// =============================================================================

const PUBKEY = "a".repeat(64);
const OTHER_PUBKEY = "b".repeat(64);

/** Records the params of every UPDATE so the naddr actually looked up can be
 *  decoded back. The deletion path's whole output is the value in `$2`. */
function recordingDb(): Queryable & { naddrs: () => string[] } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    naddrs: () =>
      calls
        .filter((c) => String(c.sql).includes("source_item_uri = $2"))
        .map((c) => String(c.params[1])),
  } as Queryable & { naddrs: () => string[] };
}

function deletionEvent(coord: string, pubkey = PUBKEY): NostrEvent {
  return {
    id: "d".repeat(64),
    pubkey,
    created_at: 1_700_000_000,
    kind: 5,
    tags: [["a", coord]],
    content: "",
  } as NostrEvent;
}

function repostEvent(coord: string): NostrEvent {
  return {
    id: "e".repeat(64),
    pubkey: OTHER_PUBKEY,
    created_at: 1_700_000_000,
    kind: 6,
    tags: [["a", coord]],
    content: "",
  } as NostrEvent;
}

/** The identifier that comes back out of an naddr — what the lookup key means. */
function identifierOf(naddr: string): string {
  const decoded = nip19.decode(naddr);
  return (decoded.data as { identifier: string }).identifier;
}

describe("an `a` coordinate's d-identifier may contain colons", () => {
  it("a deletion keeps the WHOLE identifier, colons and all", async () => {
    const db = recordingDb();
    await applyNostrDeletions(
      db,
      "src-1",
      [deletionEvent(`30023:${PUBKEY}:on-writing:part-two`)],
      PUBKEY,
    );

    const [naddr] = db.naddrs();
    expect(naddr).toBeDefined();
    // Truncating at the second colon yields `on-writing`, which names a
    // different (usually non-existent) article — the deletion is then a no-op.
    expect(identifierOf(naddr)).toBe("on-writing:part-two");
  });

  it("CONTROL — an ordinary colon-free identifier is unchanged", async () => {
    const db = recordingDb();
    await applyNostrDeletions(
      db,
      "src-1",
      [deletionEvent(`30023:${PUBKEY}:on-writing`)],
      PUBKEY,
    );

    expect(identifierOf(db.naddrs()[0])).toBe("on-writing");
  });

  it("the two readers of an `a` tag mint the SAME key for the same coordinate", async () => {
    const coord = `30023:${PUBKEY}:a:b:c`;

    const db = recordingDb();
    await applyNostrDeletions(db, "src-1", [deletionEvent(coord)], PUBKEY);
    const deletionKey = db.naddrs()[0];

    const repost = detectNostrRepost(repostEvent(coord));

    // A deletion that cannot name what a repost named is a deletion that never
    // applies to it. This is the invariant, not the colon: the colon is only
    // how the two spellings were caught disagreeing.
    expect(repost?.targetHandle).toBe(deletionKey);
  });

  it("an empty identifier — a non-parameterized replaceable coord — still resolves", () => {
    expect(parseNostrAddrCoord(`10002:${PUBKEY}:`)).toEqual({
      kind: 10002,
      pubkey: PUBKEY,
      identifier: "",
    });
    // And with no trailing colon at all, which is the other conformant spelling.
    expect(parseNostrAddrCoord(`10002:${PUBKEY}`)).toEqual({
      kind: 10002,
      pubkey: PUBKEY,
      identifier: "",
    });
  });

  it("refuses a coordinate with no kind or no pubkey rather than half-parsing it", () => {
    expect(parseNostrAddrCoord("")).toBeNull();
    expect(parseNostrAddrCoord("notakind:${PUBKEY}:x")).toBeNull();
    expect(parseNostrAddrCoord("30023")).toBeNull();
    expect(parseNostrAddrCoord("30023:")).toBeNull();
  });

  // The ownership guard is the reason the deletion path parses at all, and the
  // refactor moved the `pubkey` check to the other side of the parse — so it is
  // asserted here rather than assumed to have survived.
  it("still refuses an `a` tag naming a pubkey the source does not own", async () => {
    const db = recordingDb();
    await applyNostrDeletions(
      db,
      "src-1",
      [deletionEvent(`30023:${OTHER_PUBKEY}:anything:at:all`, PUBKEY)],
      PUBKEY,
    );

    expect(db.naddrs()).toHaveLength(0);
  });

  it("still refuses a kind that is not replaceable", async () => {
    const db = recordingDb();
    await applyNostrDeletions(
      db,
      "src-1",
      [deletionEvent(`1:${PUBKEY}:with:colons`)],
      PUBKEY,
    );

    expect(db.naddrs()).toHaveLength(0);
  });
});
