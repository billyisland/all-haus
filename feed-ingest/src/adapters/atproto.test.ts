import { describe, it, expect } from "vitest";
import {
  buildAtUri,
  normaliseAtprotoPost,
  normaliseAtprotoCommit,
  type BskyPostRecord,
  type JetstreamCommit,
} from "./atproto.js";

const DID = "did:plc:testuser123";
const RKEY = "3testrecordkey";
const COLLECTION = "app.bsky.feed.post";
const FALLBACK_DATE = new Date("2026-01-15T12:00:00Z");

function makeRecord(overrides: Partial<BskyPostRecord> = {}): BskyPostRecord {
  return {
    text: "Hello world",
    $type: "app.bsky.feed.post",
    createdAt: "2026-01-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeCommit(overrides: Partial<JetstreamCommit> = {}): JetstreamCommit {
  return {
    did: DID,
    time_us: FALLBACK_DATE.getTime() * 1000,
    kind: "commit",
    commit: {
      rev: "rev1",
      operation: "create",
      collection: COLLECTION,
      rkey: RKEY,
      record: makeRecord(),
      cid: "bafytest123",
    },
    ...overrides,
  };
}

describe("buildAtUri", () => {
  it("constructs an at:// URI", () => {
    expect(buildAtUri(DID, COLLECTION, RKEY)).toBe(
      `at://${DID}/${COLLECTION}/${RKEY}`,
    );
  });
});

describe("normaliseAtprotoPost", () => {
  it("normalises a plain text post", () => {
    const result = normaliseAtprotoPost({
      did: DID,
      uri: `at://${DID}/${COLLECTION}/${RKEY}`,
      cid: "bafytest",
      record: makeRecord(),
      fallbackDate: FALLBACK_DATE,
    });

    expect(result.contentText).toBe("Hello world");
    expect(result.contentHtml).toContain("Hello world");
    expect(result.sourceItemUri).toBe(`at://${DID}/${COLLECTION}/${RKEY}`);
    expect(result.isRepost).toBe(false);
    expect(result.sourceReplyUri).toBeNull();
    expect(result.sourceQuoteUri).toBeNull();
    expect(result.media).toEqual([]);
    expect(result.interactionData.uri).toBe(
      `at://${DID}/${COLLECTION}/${RKEY}`,
    );
    expect(result.interactionData.cid).toBe("bafytest");
  });

  it("uses fallback date when createdAt is missing", () => {
    const result = normaliseAtprotoPost({
      did: DID,
      uri: `at://${DID}/${COLLECTION}/${RKEY}`,
      cid: null,
      record: makeRecord({ createdAt: undefined as unknown as string }),
      fallbackDate: FALLBACK_DATE,
    });
    expect(result.publishedAt).toEqual(FALLBACK_DATE);
  });

  it("uses fallback date when createdAt is invalid", () => {
    const result = normaliseAtprotoPost({
      did: DID,
      uri: `at://${DID}/${COLLECTION}/${RKEY}`,
      cid: null,
      record: makeRecord({ createdAt: "not-a-date" }),
      fallbackDate: FALLBACK_DATE,
    });
    expect(result.publishedAt).toEqual(FALLBACK_DATE);
  });

  it("extracts first language from langs array", () => {
    const result = normaliseAtprotoPost({
      did: DID,
      uri: `at://${DID}/${COLLECTION}/${RKEY}`,
      cid: null,
      record: makeRecord({ langs: ["en", "fr"] }),
      fallbackDate: FALLBACK_DATE,
    });
    expect(result.language).toBe("en");
  });

  it("returns null language when no langs", () => {
    const result = normaliseAtprotoPost({
      did: DID,
      uri: `at://${DID}/${COLLECTION}/${RKEY}`,
      cid: null,
      record: makeRecord(),
      fallbackDate: FALLBACK_DATE,
    });
    expect(result.language).toBeNull();
  });

  it("always carries the author DID; handle/name only when a profile is given", () => {
    const bare = normaliseAtprotoPost({
      did: DID,
      uri: `at://${DID}/${COLLECTION}/${RKEY}`,
      cid: null,
      record: makeRecord(),
      fallbackDate: FALLBACK_DATE,
    });
    // Jetstream-style call (no profile inline): DID present, handle/name absent
    // so the ingest falls back to the source's stored identity.
    expect(bare.authorDid).toBe(DID);
    expect(bare.authorHandle).toBeUndefined();
    expect(bare.authorName).toBeUndefined();

    const withProfile = normaliseAtprotoPost({
      did: DID,
      uri: `at://${DID}/${COLLECTION}/${RKEY}`,
      cid: null,
      record: makeRecord(),
      fallbackDate: FALLBACK_DATE,
      author: { handle: "alice.bsky.social", displayName: "Alice" },
    });
    expect(withProfile.authorDid).toBe(DID);
    expect(withProfile.authorHandle).toBe("alice.bsky.social");
    expect(withProfile.authorName).toBe("Alice");
  });

  it("extracts reply parent URI into sourceReplyUri", () => {
    const result = normaliseAtprotoPost({
      did: DID,
      uri: `at://${DID}/${COLLECTION}/${RKEY}`,
      cid: null,
      record: makeRecord({
        reply: {
          parent: {
            uri: "at://did:plc:other/app.bsky.feed.post/parent1",
            cid: "cid1",
          },
          root: {
            uri: "at://did:plc:other/app.bsky.feed.post/root1",
            cid: "cid2",
          },
        },
      }),
      fallbackDate: FALLBACK_DATE,
    });
    expect(result.sourceReplyUri).toBe(
      "at://did:plc:other/app.bsky.feed.post/parent1",
    );
    expect(result.interactionData.parentUri).toBe(
      "at://did:plc:other/app.bsky.feed.post/parent1",
    );
    expect(result.interactionData.rootUri).toBe(
      "at://did:plc:other/app.bsky.feed.post/root1",
    );
  });
});

describe("normaliseAtprotoCommit", () => {
  it("normalises a create commit", () => {
    const result = normaliseAtprotoCommit(makeCommit());
    expect(result).not.toBeNull();
    expect(result!.contentText).toBe("Hello world");
    expect(result!.sourceItemUri).toContain(DID);
  });

  it("returns null for non-post collections", () => {
    const commit = makeCommit();
    commit.commit!.collection = "app.bsky.feed.like";
    expect(normaliseAtprotoCommit(commit)).toBeNull();
  });

  it("returns null for delete operations", () => {
    const commit = makeCommit();
    commit.commit!.operation = "delete";
    expect(normaliseAtprotoCommit(commit)).toBeNull();
  });

  it("returns null when commit is missing", () => {
    expect(
      normaliseAtprotoCommit({
        did: DID,
        time_us: 0,
        kind: "commit",
      } as JetstreamCommit),
    ).toBeNull();
  });

  it("returns null when record is missing", () => {
    const commit = makeCommit();
    commit.commit!.record = undefined as unknown as BskyPostRecord;
    expect(normaliseAtprotoCommit(commit)).toBeNull();
  });
});
