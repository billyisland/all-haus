import { describe, it, expect } from "vitest";
import {
  detectAtprotoRepostFromCommit,
  detectAtprotoRepostFromReason,
  type JetstreamCommit,
} from "../adapters/atproto.js";
import { detectActivityPubRepost } from "../adapters/activitypub.js";
import { detectNostrRepost } from "./nostr-ingest.js";
import { nip19 } from "nostr-tools";

// =============================================================================
// Phase 0c repost detection — pure-function coverage for every detecting
// adapter (UNIVERSAL-POST-ADR §2.2/§0.2). Each detector turns boost-shaped
// input into a DetectedRepost (an EDGE) and turns everything else into null
// (so it falls through to normal THING ingestion). The DB-level invariants
// (derive parity, idempotency, cross-source dedup) are exercised separately by
// the rolled-back synthetic SQL test described in the Phase 0c worklog.
// =============================================================================

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

describe("detectAtprotoRepostFromCommit", () => {
  // Build a app.bsky.feed.repost commit. `commitOverride` patches the commit
  // envelope (operation/collection); `record` (when provided) replaces the
  // repost record wholesale so a test can drop createdAt/subject.
  function commit(
    opts: {
      commitOverride?: Record<string, unknown>;
      record?: Record<string, unknown> | null;
    } = {},
  ): JetstreamCommit {
    const record =
      opts.record === undefined
        ? {
            subject: { uri: "at://did:plc:author/app.bsky.feed.post/orig1" },
            createdAt: "2026-05-31T10:00:00.000Z",
          }
        : opts.record;
    return {
      did: "did:plc:booster",
      time_us: 1_700_000_000_000_000,
      kind: "commit",
      commit: {
        operation: "create",
        collection: "app.bsky.feed.repost",
        rkey: "rkey123",
        record,
        ...opts.commitOverride,
      },
    } as unknown as JetstreamCommit;
  }

  it("detects a repost commit", () => {
    const r = detectAtprotoRepostFromCommit(commit());
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("atproto");
    expect(r!.targetHandle).toBe(
      "at://did:plc:author/app.bsky.feed.post/orig1",
    );
    expect(r!.actorHandle).toBe("did:plc:booster");
    expect(r!.originUri).toBe(
      "at://did:plc:booster/app.bsky.feed.repost/rkey123",
    );
    expect(r!.boostedAt.toISOString()).toBe("2026-05-31T10:00:00.000Z");
  });

  it("ignores a post commit (that is a THING, not an edge)", () => {
    const c = commit();
    c.commit!.collection = "app.bsky.feed.post";
    expect(detectAtprotoRepostFromCommit(c)).toBeNull();
  });

  it("ignores a repost delete (un-repost)", () => {
    const c = commit();
    c.commit!.operation = "delete";
    expect(detectAtprotoRepostFromCommit(c)).toBeNull();
  });

  it("returns null when subject uri is absent", () => {
    const c = commit({ record: {} });
    expect(detectAtprotoRepostFromCommit(c)).toBeNull();
  });

  it("falls back to time_us when record createdAt is missing", () => {
    const c = commit({
      record: {
        subject: { uri: "at://did:plc:author/app.bsky.feed.post/orig1" },
      },
    });
    const r = detectAtprotoRepostFromCommit(c)!;
    expect(r.boostedAt.getTime()).toBe(1_700_000_000_000);
  });
});

describe("detectAtprotoRepostFromReason", () => {
  it("detects a reasonRepost feed entry", () => {
    const r = detectAtprotoRepostFromReason({
      reason: {
        $type: "app.bsky.feed.defs#reasonRepost",
        by: { did: "did:plc:booster" },
        indexedAt: "2026-05-31T11:00:00.000Z",
      },
      postUri: "at://did:plc:author/app.bsky.feed.post/orig2",
      fallbackDate: new Date("2026-01-01T00:00:00Z"),
    });
    expect(r).not.toBeNull();
    expect(r!.actorHandle).toBe("did:plc:booster");
    expect(r!.targetHandle).toBe(
      "at://did:plc:author/app.bsky.feed.post/orig2",
    );
    expect(r!.originUri).toBeNull(); // getAuthorFeed does not expose the record uri
  });

  it("ignores a non-repost reason", () => {
    expect(
      detectAtprotoRepostFromReason({
        reason: { $type: "app.bsky.feed.defs#reasonPin" },
        postUri: "at://x/app.bsky.feed.post/y",
        fallbackDate: new Date(),
      }),
    ).toBeNull();
  });

  it("returns null when the booster did is absent", () => {
    expect(
      detectAtprotoRepostFromReason({
        reason: { $type: "app.bsky.feed.defs#reasonRepost", by: {} },
        postUri: "at://x/app.bsky.feed.post/y",
        fallbackDate: new Date(),
      }),
    ).toBeNull();
  });
});

describe("detectActivityPubRepost", () => {
  it("detects a public Announce", () => {
    const r = detectActivityPubRepost({
      id: "https://mas.to/users/booster/statuses/1/activity",
      type: "Announce",
      actor: "https://mas.to/users/booster",
      object: "https://other.social/users/author/statuses/9",
      published: "2026-05-31T12:00:00.000Z",
      to: [PUBLIC],
    });
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("activitypub");
    expect(r!.actorHandle).toBe("https://mas.to/users/booster");
    expect(r!.targetHandle).toBe(
      "https://other.social/users/author/statuses/9",
    );
    expect(r!.originUri).toBe(
      "https://mas.to/users/booster/statuses/1/activity",
    );
  });

  it("reads actor/object given as objects with id", () => {
    const r = detectActivityPubRepost({
      type: "Announce",
      actor: { id: "https://mas.to/users/booster" },
      object: { id: "https://other.social/objects/9" },
      cc: [PUBLIC],
    });
    expect(r!.actorHandle).toBe("https://mas.to/users/booster");
    expect(r!.targetHandle).toBe("https://other.social/objects/9");
  });

  it("ignores a Create (that is a THING)", () => {
    expect(
      detectActivityPubRepost({ type: "Create", to: [PUBLIC] }),
    ).toBeNull();
  });

  it("ignores a non-public Announce", () => {
    expect(
      detectActivityPubRepost({
        type: "Announce",
        actor: "https://mas.to/users/booster",
        object: "https://other.social/objects/9",
        to: ["https://mas.to/users/booster/followers"],
      }),
    ).toBeNull();
  });
});

describe("detectNostrRepost", () => {
  // Valid 32-byte hex (the encoders reject malformed ids/pubkeys).
  const EVENT_ID = "a".repeat(64);
  const AUTHOR_PK = "b".repeat(64);
  const base = {
    id: "c".repeat(64),
    pubkey: "d".repeat(64),
    created_at: 1_780_000_000,
    sig: "sig",
    content: "",
  };

  it("encodes a kind-6 note repost as the THING's relay-free nevent", () => {
    // C1 parity: the edge target equals the boosted note's relay-free
    // source_item_uri — nip19.neventEncode({id}) with NO relay hints — so it
    // joins the THING's feed_items.post_id. A relay hint on the tag is ignored.
    const r = detectNostrRepost({
      ...base,
      kind: 6,
      tags: [["e", EVENT_ID, "wss://relay.example"]],
    });
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("nostr_external");
    expect(r!.targetHandle).toBe(nip19.neventEncode({ id: EVENT_ID }));
    expect(r!.actorHandle).toBe(base.pubkey);
    expect(r!.originUri).toBe(base.id);
    expect(r!.boostedAt.getTime()).toBe(1_780_000_000 * 1000);
  });

  it("encodes a kind-16 addressable repost as the THING's relay-free naddr", () => {
    const r = detectNostrRepost({
      ...base,
      kind: 16,
      tags: [["a", `30023:${AUTHOR_PK}:my-article`]],
    });
    expect(r!.targetHandle).toBe(
      nip19.naddrEncode({ kind: 30023, pubkey: AUTHOR_PK, identifier: "my-article" }),
    );
  });

  it("prefers the addressable 'a' coordinate (naddr THING) over the 'e' tag", () => {
    // An addressable target is stored under naddr, so when a boost carries both
    // a specific-version 'e' and the 'a' coordinate, the 'a' tag is what joins.
    const r = detectNostrRepost({
      ...base,
      kind: 16,
      tags: [
        ["a", `30023:${AUTHOR_PK}:my-article`],
        ["e", EVENT_ID],
      ],
    });
    expect(r!.targetHandle).toBe(
      nip19.naddrEncode({ kind: 30023, pubkey: AUTHOR_PK, identifier: "my-article" }),
    );
  });

  it("keeps a ':' inside the d-identifier of an 'a' coordinate", () => {
    const r = detectNostrRepost({
      ...base,
      kind: 16,
      tags: [["a", `30023:${AUTHOR_PK}:weird:id:with:colons`]],
    });
    expect(r!.targetHandle).toBe(
      nip19.naddrEncode({
        kind: 30023,
        pubkey: AUTHOR_PK,
        identifier: "weird:id:with:colons",
      }),
    );
  });

  it("falls back to the 'e' tag when the 'a' coordinate is malformed", () => {
    const r = detectNostrRepost({
      ...base,
      kind: 16,
      tags: [
        ["a", "not-a-coordinate"],
        ["e", EVENT_ID],
      ],
    });
    expect(r!.targetHandle).toBe(nip19.neventEncode({ id: EVENT_ID }));
  });

  it("ignores a kind-1 note (that is a THING)", () => {
    expect(
      detectNostrRepost({ ...base, kind: 1, tags: [["e", EVENT_ID]] }),
    ).toBeNull();
  });

  it("returns null when no e/a tag points at a target", () => {
    expect(detectNostrRepost({ ...base, kind: 6, tags: [["p", "x"]] })).toBeNull();
  });
});
