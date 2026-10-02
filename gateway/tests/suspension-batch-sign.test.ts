import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// =============================================================================
// A SUSPENSION SIGNS ITS TOMBSTONES IN ONE BATCH PER AUTHOR (CA-A8, 2026-09-29).
//
// `signRemovals` called key-custody's `/keypairs/sign` once per article, note
// and reply, all as the content's author — and that route's budget is 120 a
// minute PER SIGNER. So a member with 121 published pieces could not be
// suspended at all: the 121st sign answered 429, the client threw, the route
// 500'd, and `status` was never written. The most prolific member was the one
// the ladder could not reach.
//
// WHAT THIS ASSERTS. The mocked client counts its calls: 300 pieces are ONE
// `signEvents` call and ZERO `signEvent` calls, and the signed events land on
// the rows they were made for (positionally). A route that went back to a
// sign per piece fails the count; one that mis-slotted the results fails the
// position check. The delete-account path's shortfall count is a structural
// pin, since driving that route needs the whole auth harness.
//
// Mutation-checked: revert `signRemovals` to the per-item loop → the first two
// cases red; shuffle the slot mapping → the position case red.
// =============================================================================

process.env.APP_URL ??= "https://all.haus.test";

const signEvents = vi.fn(async (signer: string, templates: Array<{ tags: string[][] }>) =>
  templates.map((t, i) => ({
    id: `${signer.slice(0, 8)}-${i}`,
    pubkey: "p".repeat(64),
    sig: "s".repeat(128),
    kind: 5,
    content: "",
    tags: t.tags,
    created_at: 1,
  })),
);
const signEvent = vi.fn(async () => ({}));

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@platform-pub/shared/lib/member-notices.js", () => ({
  sendModerationNoticeEmail: vi.fn(async () => ({ sent: 1, skipped: 0 })),
  MODERATION_NOTICE_KINDS: [],
}));
vi.mock("@platform-pub/shared/auth/magic-links.js", () => ({
  requestStepUpToken: vi.fn(),
  claimStepUpToken: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(async () => {}),
}));
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: (...a: unknown[]) => signEvent(...(a as [])),
  signEvents: (...a: unknown[]) => signEvents(...(a as [string, Array<{ tags: string[][] }>])),
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _reply: unknown, done: () => void) => done(),
  invalidateAuthCache: vi.fn(),
}));
vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (_req: unknown, _reply: unknown, done: () => void) => done(),
  getAdminIds: () => Promise.resolve([]),
}));

const { signRemovals } = await import("../src/routes/moderation.js");

const AUTHOR = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const ev = (i: number) => String(i).padStart(64, "e");

beforeEach(() => {
  signEvents.mockClear();
  signEvent.mockClear();
});

describe("signRemovals batches per author", () => {
  it("300 pieces are ONE batch call and no single sign — the 121st piece no longer 429s", async () => {
    const articles = Array.from({ length: 100 }, (_, i) => ({
      id: `a${i}`, nostr_event_id: ev(i), nostr_d_tag: `d${i}`, writer_id: AUTHOR, nostr_pubkey: "p".repeat(64),
    }));
    const notes = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, nostr_event_id: ev(100 + i), author_id: AUTHOR }));
    const comments = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, nostr_event_id: ev(200 + i), author_id: AUTHOR }));

    const prepared = await signRemovals(articles, notes, comments);

    expect(signEvents).toHaveBeenCalledTimes(1);
    expect(signEvent).not.toHaveBeenCalled();
    const [signer, templates] = signEvents.mock.calls[0];
    expect(signer).toBe(AUTHOR);
    expect(templates).toHaveLength(300);
    expect(templates.every((t: { kind: number }) => t.kind === 5)).toBe(true);
    expect(prepared.articles).toHaveLength(100);
    expect(prepared.notes).toHaveLength(100);
    expect(prepared.comments).toHaveLength(100);
    expect(prepared.articles.every((a) => a.tombstone !== null)).toBe(true);
    expect(prepared.comments.every((c) => c.tombstone !== null)).toBe(true);
    expect(prepared.ownerAccountId).toBe(AUTHOR);
  });

  it("puts each signed event back on the row it was made for", async () => {
    const articles = [
      { id: "a0", nostr_event_id: ev(0), nostr_d_tag: "d0", writer_id: AUTHOR, nostr_pubkey: "p".repeat(64) },
      // Never reached the relay: no template is sent for it, and its slot
      // stays null rather than swallowing the next row's signature.
      { id: "a1", nostr_event_id: null, nostr_d_tag: null, writer_id: AUTHOR, nostr_pubkey: "p".repeat(64) },
      { id: "a2", nostr_event_id: ev(2), nostr_d_tag: "d2", writer_id: AUTHOR, nostr_pubkey: "p".repeat(64) },
    ];
    const notes = [{ id: "n0", nostr_event_id: ev(3), author_id: AUTHOR }];

    const prepared = await signRemovals(articles, notes);

    expect(signEvents.mock.calls[0][1]).toHaveLength(3);
    expect(prepared.articles[0].tombstone?.tags).toEqual([["e", ev(0)], ["a", `30023:${"p".repeat(64)}:d0`]]);
    expect(prepared.articles[1].tombstone).toBeNull();
    expect(prepared.articles[2].tombstone?.tags).toEqual([["e", ev(2)], ["a", `30023:${"p".repeat(64)}:d2`]]);
    expect(prepared.notes[0].tombstone?.tags).toEqual([["e", ev(3)]]);
  });

  it("two authors are two batches, each signed as its own author", async () => {
    const notes = [
      { id: "n0", nostr_event_id: ev(0), author_id: AUTHOR },
      { id: "n1", nostr_event_id: ev(1), author_id: OTHER },
      { id: "n2", nostr_event_id: ev(2), author_id: AUTHOR },
    ];
    const prepared = await signRemovals([], notes);
    expect(signEvents).toHaveBeenCalledTimes(2);
    const signers = signEvents.mock.calls.map((c) => c[0]).sort();
    expect(signers).toEqual([AUTHOR, OTHER].sort());
    expect(prepared.notes[1].tombstone?.id.startsWith(OTHER.slice(0, 8))).toBe(true);
    expect(prepared.notes[2].tombstone?.id.startsWith(AUTHOR.slice(0, 8))).toBe(true);
  });

  it("a signer failure throws whole — the request fails cleanly BEFORE anything is written (§0f-14 kept)", async () => {
    signEvents.mockRejectedValueOnce(new Error("key-custody /api/v1/keypairs/sign-batch failed: 503"));
    await expect(signRemovals([], [{ id: "n0", nostr_event_id: ev(0), author_id: AUTHOR }])).rejects.toThrow(/503/);
  });
});

describe("the delete-account path (structural)", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/routes/auth.ts"), "utf8");
  it("signs its tombstones in one batch and counts the shortfall beside the total", () => {
    expect(src).toMatch(/await signEvents\(accountId, tombstones\.map\(\(t\) => t\.template\)\)/);
    expect(src).toMatch(/tombstonesSkipped = tombstones\.length/);
    expect(src).toMatch(/total: tombstones\.length, enqueued: tombstonesEnqueued, skipped: tombstonesSkipped/);
    // The per-item sign inside the deletion transaction is gone.
    const deletion = src.slice(src.indexOf('"/auth/delete-account"'));
    expect(deletion).not.toMatch(/await signEvent\(accountId, \{\s*kind: 5/);
  });
});
