import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";

// =============================================================================
// Replies, mentions and quotes come home as notifications
// (CROSS-NETWORK-ROUNDTRIP-ADR rung C) — the poller against a live Postgres.
//
// The networks are faked at the ADAPTER seam (what the member's PDS or
// instance answers); everything past it is real: the claim, the shadow source,
// `persistHydratedThreadNodes`, the echo join to the member's note, the unique
// index that decides what a notification is, the cursor and the heartbeat, and
// the presence invalidation. What these decide is Postgres's to evaluate — a
// mocked pool would agree with any predicate it was told matches.
//
// The shared pool and `withTransaction` are routed onto ONE client inside a
// transaction that is always rolled back. Skipped without a DB URL; CI
// attaches one and fails on a skip.
//
// Mutations it was proved against (each turns a case red):
//   · idx_notifications_external_item made partial on `read = false`
//                                            → "a post met again after it was read"
//   · ECHO_NOTE_SQL joins on op.account_id <> $1
//                                            → "a Bluesky reply to a cross-post …"
//   · ECHO_NOTE_SQL's `op.account_id = $1` made vacuous (`OR TRUE`)
//                                            → "binds only the RECIPIENT's own note"
//   · the cursor assigned after handleHit's throw (walk.cursor = n.indexedAt
//     moved above the handle)                → "a failure mid-batch keeps …"
//   · `if (hit.authorKey === p.external_id) return "self"` deleted
//                                            → "the member's own post"
//   · pollPresences' per-presence try/catch removed (failure propagates)
//                                            → "one failing presence …"
//   · recordOutcome's invalidation branch deleted
//                                            → "a refused Mastodon token …"
//   · CLAIM_DUE_PRESENCES_SQL loses `provenance <> 'concierge'`
//                                            → "claims only what is due"
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const db: { client: pg.PoolClient | null } = { client: null };
const q = (text: string, values?: unknown[]) => db.client!.query(text, values);

// withTransaction is a SAVEPOINT, so a hit that throws is rolled back whole —
// as its own transaction is in production — and leaves the outer test
// transaction usable for the outcome write that follows.
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (text: string, values?: unknown[]) => q(text, values) },
  withTransaction: async (cb: (c: unknown) => Promise<unknown>) => {
    await q("SAVEPOINT hit");
    try {
      const out = await cb(db.client);
      await q("RELEASE SAVEPOINT hit");
      return out;
    } catch (err) {
      await q("ROLLBACK TO SAVEPOINT hit");
      throw err;
    }
  },
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Credentials are stored as plain JSON in the fixtures.
vi.mock("@platform-pub/shared/lib/crypto.js", () => ({
  decryptJson: (blob: string) => JSON.parse(blob),
}));

const bsky = { pages: [] as Array<{ notifications: unknown[]; cursor?: string }>, fail: null as Error | null };
vi.mock("../adapters/linked-notifications.js", () => ({
  listBlueskyNotifications: vi.fn(async (_did: string, pageCursor?: string) => {
    if (bsky.fail) throw bsky.fail;
    return bsky.pages[pageCursor ? Number(pageCursor) : 0] ?? { notifications: [] };
  }),
}));

const masto = {
  pages: [] as unknown[][],
  parents: new Map<string, unknown>(),
  fail: null as Error | null,
};
vi.mock("../adapters/activitypub-outbound.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../adapters/activitypub-outbound.js")>();
  return {
    ...real,
    listMastodonNotifications: vi.fn(async () => {
      if (masto.fail) throw masto.fail;
      return masto.pages.shift() ?? [];
    }),
    readHomeInstanceStatus: vi.fn(async (_i: string, _c: unknown, id: string) => masto.parents.get(id) ?? null),
  };
});

const { pollPresences, CLAIM_DUE_PRESENCES_SQL } = await import("./linked-notifications-poll.js");
const { CredentialRefusedError } = await import("../lib/outbound-errors.js");
const { NOTIFICATIONS_NEEDS_RECONNECT } = await import("@platform-pub/shared/lib/presence-health.js");

const hex = (n = 32) => randomBytes(n).toString("hex");
const NOW = new Date();
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString();

describe.skipIf(!DB_URL)("linked_notifications_poll", () => {
  let pool: pg.Pool;
  let member: string;
  let memberDid: string;
  let bskyPresence: string;
  let mastoPresence: string;
  let noteId: string;
  const echoUri = () => `at://${memberDid}/app.bsky.feed.post/echo1`;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    db.client = await pool.connect();
    await q("BEGIN");
    bsky.pages = [];
    bsky.fail = null;
    masto.pages = [];
    masto.parents = new Map();
    masto.fail = null;
    memberDid = `did:plc:member${hex(6)}`;
    member = (
      await q(`INSERT INTO accounts (username, nostr_pubkey) VALUES ($1, $2) RETURNING id`, [
        `m-${hex(4)}`,
        hex(),
      ])
    ).rows[0].id;
    bskyPresence = (
      await q(
        `INSERT INTO network_presences (account_id, protocol, external_id) VALUES ($1, 'atproto', $2) RETURNING id`,
        [member, memberDid],
      )
    ).rows[0].id;
    mastoPresence = (
      await q(
        `INSERT INTO network_presences (account_id, protocol, external_id, service_url, credentials_enc)
         VALUES ($1, 'activitypub', '1001', 'https://home.example', $2) RETURNING id`,
        [member, JSON.stringify({ accessToken: "t", scope: "read write" })],
      )
    ).rows[0].id;
    // The member's note, cross-posted to Bluesky: its echo lives at echoUri().
    const eventId = hex();
    noteId = (
      await q(
        `INSERT INTO notes (author_id, nostr_event_id, content, char_count, published_at)
         VALUES ($1, $2, 'hello', 5, now()) RETURNING id`,
        [member, eventId],
      )
    ).rows[0].id;
    await q(
      `INSERT INTO feed_items (item_type, note_id, author_id, content_preview, nostr_event_id, published_at)
       VALUES ('note', $1, $2, 'hello', $3, now())`,
      [noteId, member, eventId],
    );
    await q(
      `INSERT INTO outbound_posts (account_id, linked_account_id, protocol, nostr_event_id, action_type, status, external_post_uri, sent_at)
       VALUES ($1, $2, 'atproto', $3, 'original', 'sent', $4, now())`,
      [member, bskyPresence, eventId, echoUri()],
    );
  });
  afterEach(async () => {
    await q("ROLLBACK");
    db.client!.release();
    db.client = null;
  });

  async function presence(id: string) {
    return (
      await q(
        `SELECT id, account_id, protocol::text AS protocol, external_id, handle, service_url,
                credentials_enc, notifications_cursor, notifications_polled_at,
                notifications_poll_error, is_valid
           FROM network_presences WHERE id = $1`,
        [id],
      )
    ).rows[0];
  }
  async function notifications() {
    return (
      await q(
        `SELECT n.type, n.actor_id, n.note_id, n.read, ei.source_item_uri, ei.is_context_only,
                ei.source_reply_uri, es.source_uri AS anchored_on, es.is_active AS anchor_active
           FROM notifications n
           JOIN external_items ei ON ei.id = n.external_item_id
           JOIN external_sources es ON es.id = ei.source_id
          WHERE n.recipient_id = $1
          ORDER BY ei.source_item_uri`,
        [member],
      )
    ).rows;
  }
  const poll = async (...ids: string[]) =>
    pollPresences(await Promise.all(ids.map(presence)), { backfillHours: 72, now: NOW });

  function bskyNote(opts: {
    rkey: string;
    reason: string;
    did?: string;
    mins: number;
    replyTo?: string;
  }) {
    const did = opts.did ?? "did:plc:stranger";
    return {
      uri: `at://${did}/app.bsky.feed.post/${opts.rkey}`,
      cid: `cid-${opts.rkey}`,
      author: { did, handle: "stranger.bsky.social", displayName: "Stranger" },
      reason: opts.reason,
      record: {
        $type: "app.bsky.feed.post",
        text: `text ${opts.rkey}`,
        createdAt: ago(opts.mins),
        ...(opts.replyTo
          ? { reply: { root: { uri: opts.replyTo, cid: "c" }, parent: { uri: opts.replyTo, cid: "c" } } }
          : {}),
      },
      indexedAt: ago(opts.mins),
    };
  }

  it("a Bluesky reply to a cross-post: context row on the author's shadow source, a notification bound to it AND to the note", async () => {
    bsky.pages = [{ notifications: [bskyNote({ rkey: "r1", reason: "reply", mins: 5, replyTo: echoUri() })] }];
    const tally = await poll(bskyPresence);
    expect(tally).toMatchObject({ succeeded: 1, notified: 1, failed: 0 });
    expect(await notifications()).toEqual([
      {
        type: "external_reply",
        actor_id: null,
        note_id: noteId,
        read: false,
        source_item_uri: "at://did:plc:stranger/app.bsky.feed.post/r1",
        is_context_only: true,
        source_reply_uri: echoUri(),
        anchored_on: "did:plc:stranger",
        anchor_active: false,
      },
    ]);
    const p = await presence(bskyPresence);
    expect(p.notifications_cursor).toBe(ago(5));
    expect(p.notifications_polled_at).not.toBeNull();
    expect(p.notifications_poll_error).toBeNull();
  });

  it("binds only the RECIPIENT's own note — a reply under somebody else's cross-post that mentions them binds none", async () => {
    // Member B cross-posted too; a stranger answers B's echo and mentions A.
    const b = (
      await q(`INSERT INTO accounts (username, nostr_pubkey) VALUES ($1, $2) RETURNING id`, [`b-${hex(4)}`, hex()])
    ).rows[0].id;
    const bEvent = hex();
    const bNote = (
      await q(
        `INSERT INTO notes (author_id, nostr_event_id, content, char_count, published_at)
         VALUES ($1, $2, 'b', 1, now()) RETURNING id`,
        [b, bEvent],
      )
    ).rows[0].id;
    await q(
      `INSERT INTO feed_items (item_type, note_id, author_id, content_preview, nostr_event_id, published_at)
       VALUES ('note', $1, $2, 'b', $3, now())`,
      [bNote, b, bEvent],
    );
    const bEcho = "at://did:plc:memberb/app.bsky.feed.post/echo";
    await q(
      `INSERT INTO outbound_posts (account_id, protocol, nostr_event_id, action_type, status, external_post_uri, sent_at)
       VALUES ($1, 'atproto', $2, 'original', 'sent', $3, now())`,
      [b, bEvent, bEcho],
    );
    bsky.pages = [{ notifications: [bskyNote({ rkey: "r1", reason: "mention", mins: 5, replyTo: bEcho })] }];
    await poll(bskyPresence);
    expect((await notifications()).map((n) => [n.type, n.note_id])).toEqual([["external_mention", null]]);
  });

  it("a post met again after it was read is never a second notification", async () => {
    bsky.pages = [{ notifications: [bskyNote({ rkey: "r1", reason: "mention", mins: 5 })] }];
    await poll(bskyPresence);
    await q(`UPDATE notifications SET read = true WHERE recipient_id = $1`, [member]);
    // The boundary is inclusive, so the same hit comes round again.
    await q(`UPDATE network_presences SET notifications_cursor = $2 WHERE id = $1`, [bskyPresence, ago(5)]);
    const tally = await poll(bskyPresence);
    expect(tally.notified).toBe(0);
    expect(await notifications()).toHaveLength(1);
  });

  it("the member's own post and a platform-blocked author are skipped, counted, and passed by the cursor", async () => {
    await q(
      `INSERT INTO platform_blocks (kind, protocol, target_key, reason) VALUES ('source', 'atproto', 'did:plc:blocked', 'test')`,
    );
    bsky.pages = [
      {
        notifications: [
          bskyNote({ rkey: "b1", reason: "reply", did: "did:plc:blocked", mins: 3, replyTo: echoUri() }),
          bskyNote({ rkey: "s1", reason: "mention", did: memberDid, mins: 4 }),
          bskyNote({ rkey: "ok", reason: "quote", mins: 6 }),
        ],
      },
    ];
    const tally = await poll(bskyPresence);
    expect(tally).toMatchObject({ notified: 1, skipped: 2 });
    expect((await notifications()).map((n) => n.source_item_uri)).toEqual([
      "at://did:plc:stranger/app.bsky.feed.post/ok",
    ]);
    // Nothing of the blocked author's was written at all.
    const written = await q(`SELECT 1 FROM external_items WHERE source_item_uri LIKE 'at://did:plc:blocked/%'`);
    expect(written.rows).toHaveLength(0);
    expect((await presence(bskyPresence)).notifications_cursor).toBe(ago(3));
  });

  it("a failure mid-batch keeps what was handled and stops the cursor at it", async () => {
    // Make the second hit's persistence throw: a node with no uri.
    const bad = bskyNote({ rkey: "x", reason: "mention", mins: 2 });
    (bad as { uri: unknown }).uri = null;
    bsky.pages = [{ notifications: [bskyNote({ rkey: "first", reason: "mention", mins: 8 }), bad] }];
    // `uri: null` fails the adapter's own shape check in production; here the
    // fake hands it straight to the task, which must fail the PRESENCE, not
    // the batch, and keep the first hit.
    const tally = await poll(bskyPresence);
    expect(tally).toMatchObject({ failed: 1, succeeded: 0, notified: 1 });
    const p = await presence(bskyPresence);
    expect(p.notifications_cursor).toBe(ago(8));
    expect(p.notifications_polled_at).toBeNull();
    expect(p.notifications_poll_error).not.toBeNull();
  });

  it("one failing presence does not stop the next", async () => {
    bsky.fail = new Error("PDS 502");
    masto.pages = [
      [
        {
          id: "500",
          type: "mention",
          inReplyToAccountId: null,
          status: {
            id: "s1",
            uri: "https://far.example/users/al/statuses/1",
            url: "https://far.example/@al/1",
            createdAt: new Date(ago(10)),
            inReplyToId: null,
            contentHtml: "<p>hi @me</p>",
            account: { id: "9", acct: "al@far.example", uri: "https://far.example/users/al", displayName: "Al", avatar: null },
            media: [],
            quoteUri: null,
          },
        },
      ],
    ];
    const tally = await poll(bskyPresence, mastoPresence);
    expect(tally).toMatchObject({ claimed: 2, failed: 1, succeeded: 1, notified: 1 });
    expect((await notifications()).map((n) => [n.type, n.anchored_on])).toEqual([
      ["external_mention", "https://far.example/users/al"],
    ]);
    expect((await presence(mastoPresence)).notifications_cursor).toBe("500");
  });

  it("a Mastodon reply to the member threads on its parent's federated uri; one whose parent is gone is skipped", async () => {
    await q(`UPDATE network_presences SET notifications_cursor = '100' WHERE id = $1`, [mastoPresence]);
    masto.parents.set("77", { uri: "https://home.example/users/me/statuses/77" });
    const status = (id: string, parent: string) => ({
      id: `s${id}`,
      uri: `https://far.example/users/al/statuses/${id}`,
      url: null,
      createdAt: new Date(ago(10)),
      inReplyToId: parent,
      contentHtml: "<p>reply</p>",
      account: { id: "9", acct: "al@far.example", uri: "https://far.example/users/al", displayName: "Al", avatar: null },
      media: [],
      quoteUri: null,
    });
    masto.pages = [
      [
        { id: "101", type: "mention", inReplyToAccountId: "1001", status: status("1", "77") },
        { id: "102", type: "mention", inReplyToAccountId: "1001", status: status("2", "gone") },
      ],
    ];
    const tally = await poll(mastoPresence);
    expect(tally).toMatchObject({ notified: 1, skipped: 1, succeeded: 1 });
    expect((await notifications()).map((n) => [n.type, n.source_reply_uri])).toEqual([
      ["external_reply", "https://home.example/users/me/statuses/77"],
    ]);
    expect((await presence(mastoPresence)).notifications_cursor).toBe("102");
  });

  it("a refused Mastodon token invalidates the presence; a narrow grant awaits a reconnect and does not", async () => {
    masto.fail = new CredentialRefusedError("Mastodon notifications HTTP 401");
    let tally = await poll(mastoPresence);
    expect(tally).toMatchObject({ failed: 1, invalidated: 1 });
    expect((await presence(mastoPresence)).is_valid).toBe(false);

    await q(`UPDATE network_presences SET is_valid = TRUE, credentials_enc = $2 WHERE id = $1`, [
      mastoPresence,
      JSON.stringify({ accessToken: "t", scope: "read:accounts write:statuses" }),
    ]);
    masto.fail = null;
    tally = await poll(mastoPresence);
    expect(tally).toMatchObject({ needsReconnect: 1, failed: 0, invalidated: 0 });
    const p = await presence(mastoPresence);
    expect(p.is_valid).toBe(true);
    expect(p.notifications_poll_error.startsWith(NOTIFICATIONS_NEEDS_RECONNECT)).toBe(true);
    expect(p.notifications_polled_at).toBeNull();
  });

  it("claims only what is due, and never a concierge presence or a departed member", async () => {
    await q(`UPDATE network_presences SET notifications_attempted_at = now() WHERE id = $1`, [mastoPresence]);
    const other = (
      await q(`INSERT INTO accounts (username, nostr_pubkey, status) VALUES ($1, $2, 'deactivated') RETURNING id`, [
        `g-${hex(4)}`,
        hex(),
      ])
    ).rows[0].id;
    await q(`INSERT INTO network_presences (account_id, protocol, external_id) VALUES ($1, 'atproto', 'did:plc:gone')`, [other]);
    const concierge = (
      await q(`INSERT INTO accounts (username, nostr_pubkey) VALUES ($1, $2) RETURNING id`, [`c-${hex(4)}`, hex()])
    ).rows[0].id;
    await q(
      `INSERT INTO network_presences (account_id, protocol, external_id, provenance) VALUES ($1, 'atproto', 'did:plc:ours', 'concierge')`,
      [concierge],
    );
    const { rows } = await q(CLAIM_DUE_PRESENCES_SQL, [300, 1000]);
    const mine = rows.filter((r: { account_id: string }) => [member, other, concierge].includes(r.account_id));
    expect(mine.map((r: { id: string }) => r.id)).toEqual([bskyPresence]);
    // The claim stamped it, so a second tick inside the interval takes nothing of ours.
    const again = await q(CLAIM_DUE_PRESENCES_SQL, [300, 1000]);
    expect(again.rows.filter((r: { account_id: string }) => r.account_id === member)).toEqual([]);
  });
});
