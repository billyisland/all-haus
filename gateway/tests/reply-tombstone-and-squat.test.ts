import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";

// =============================================================================
// A reply's delete publishes a kind-5, and a reply cannot squat a note's or an
// article's event id (CA-B1 + CA-B2, 2026-09-29).
//
// B1. A reply IS a relay event — the web signs it as kind 1 and enqueues it
//     before `POST /replies` indexes it — and `DELETE /replies/:id` soft-
//     deleted the row and told the relay nothing, so the kind-1 stayed on the
//     relay and every mirror. The tombstone is signed as the REPLY'S AUTHOR
//     whoever pressed delete (NIP-09 ignores a kind-5 from any other pubkey),
//     and enqueued as `note_deletion` INSIDE the delete's transaction.
//
// B2. The reply INSERT had only the comments unique index behind it; a comment
//     planted under a live note's id won the resolver, so every reply to the
//     note answered `target_is_reply`. The refusal is 409, in the transaction.
//
// DB-backed: what is under test is which rows a write touches and whether an
// enqueue reached the SAME client as the delete. The signer and the outbox
// are spies — the enqueue spy records the client it was handed.
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.READER_HASH_KEY ??= "test-reader-hash-key";
process.env.INTERNAL_SECRET ??= "test-internal-secret";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

let viewer = "unset";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: viewer, pubkey: "0".repeat(64) };
    done();
  },
  optionalAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: viewer, pubkey: "0".repeat(64) };
    done();
  },
}));

const signEvent = vi.fn(async (signerId: string, template: Record<string, unknown>) => ({
  ...template,
  id: `tomb-${uniq()}`.padEnd(64, "0").slice(0, 64),
  pubkey: signerId,
  sig: "s".repeat(128),
}));
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: (...a: unknown[]) => signEvent(...(a as [string, Record<string, unknown>])),
}));

const enqueued: Array<{ client: unknown; input: Record<string, unknown> }> = [];
vi.mock("@platform-pub/shared/lib/relay-outbox.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueRelayPublish: vi.fn(async (client: unknown, input: Record<string, unknown>) => {
    enqueued.push({ client, input });
    return { id: "outbox-1" };
  }),
}));

/** The client each transaction handed its callback, so the enqueue's client can
 *  be matched against the DELETE's. */
const txClients: unknown[] = [];
vi.mock("@platform-pub/shared/db/client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@platform-pub/shared/db/client.js")>();
  return {
    ...real,
    withTransaction: (fn: (c: unknown) => Promise<unknown>) =>
      real.withTransaction(async (client) => {
        txClients.push(client);
        return fn(client);
      }),
  };
});

const { replyRoutes } = await import("../src/routes/replies.js");

describe.skipIf(!DB_URL)("replies — tombstone and squat", () => {
  let client: pg.Client;
  let app: FastifyInstance;
  const accounts: string[] = [];

  async function account(name: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, status)
       VALUES ($1, 'fixture-enc', $2, 'active') RETURNING id`,
      [`fixture-b1-${uniq()}`.padEnd(64, "0"), name],
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  }
  async function note(author: string): Promise<string> {
    const ev = `${uniq()}`.padEnd(64, "a");
    await client.query(`INSERT INTO notes (author_id, nostr_event_id, content) VALUES ($1, $2, 'hello')`, [author, ev]);
    return ev;
  }
  async function article(writer: string): Promise<string> {
    const ev = `${uniq()}`.padEnd(64, "b");
    const s = uniq();
    await client.query(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at)
       VALUES ($1, $2, $3, 'T', $4, now())`,
      [writer, ev, `d-${s}`, `s-${s}`],
    );
    return ev;
  }
  function as(id: string) {
    viewer = id;
  }
  const post = (who: string, body: Record<string, unknown>) => {
    as(who);
    return app.inject({ method: "POST", url: "/replies", payload: body });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = Fastify();
    await app.register(replyRoutes);
    await app.ready();
  });
  afterAll(async () => {
    if (accounts.length) {
      await client.query(`DELETE FROM feed_items WHERE author_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM comments WHERE author_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM notes WHERE author_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM articles WHERE writer_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
    }
    await app?.close();
    await client?.end();
  });
  beforeEach(() => {
    signEvent.mockClear();
    enqueued.length = 0;
    txClients.length = 0;
  });

  // --- B2 ------------------------------------------------------------------------

  it("refuses a reply whose event id names a live NOTE — 409, and no comment row", async () => {
    const writer = await account("Writer");
    const squatter = await account("Squatter");
    const target = await note(writer);
    const victim = await note(writer);
    const res = await post(squatter, {
      nostrEventId: victim,
      targetEventId: target,
      targetKind: 1,
      content: "planted",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("event_id_taken");
    const { rows } = await client.query(`SELECT 1 FROM comments WHERE nostr_event_id = $1`, [victim]);
    expect(rows).toHaveLength(0);
  });

  it("refuses a reply whose event id names an ARTICLE", async () => {
    const writer = await account("Writer");
    const squatter = await account("Squatter");
    const target = await note(writer);
    const victim = await article(writer);
    const res = await post(squatter, {
      nostrEventId: victim,
      targetEventId: target,
      targetKind: 1,
      content: "planted",
    });
    expect(res.statusCode).toBe(409);
    const { rows } = await client.query(`SELECT 1 FROM comments WHERE nostr_event_id = $1`, [victim]);
    expect(rows).toHaveLength(0);
  });

  it("still indexes an honest reply, and a repeat of its own id is the ordinary duplicate", async () => {
    const writer = await account("Writer");
    const replier = await account("Replier");
    const target = await note(writer);
    const ev = `${uniq()}`.padEnd(64, "c");
    const first = await post(replier, { nostrEventId: ev, targetEventId: target, targetKind: 1, content: "hi" });
    expect(first.statusCode).toBe(201);
    const again = await post(replier, { nostrEventId: ev, targetEventId: target, targetKind: 1, content: "hi" });
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
  });

  // --- B1 ------------------------------------------------------------------------

  async function indexedReply(writer: string, replier: string): Promise<{ id: string; ev: string }> {
    const target = await note(writer);
    const ev = `${uniq()}`.padEnd(64, "d");
    const res = await post(replier, { nostrEventId: ev, targetEventId: target, targetKind: 1, content: "hi" });
    expect(res.statusCode).toBe(201);
    return { id: res.json().commentId as string, ev };
  }

  it("the author's own delete signs a kind-5 as the author and enqueues it inside the delete's transaction", async () => {
    const writer = await account("Writer");
    const replier = await account("Replier");
    const { id, ev } = await indexedReply(writer, replier);
    txClients.length = 0;

    as(replier);
    const res = await app.inject({ method: "DELETE", url: `/replies/${id}` });
    expect(res.statusCode).toBe(200);

    expect(signEvent).toHaveBeenCalledTimes(1);
    const [signer, template] = signEvent.mock.calls[0];
    expect(signer).toBe(replier);
    expect(template).toMatchObject({ kind: 5, tags: [["e", ev]] });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].input).toMatchObject({ entityType: "note_deletion", entityId: id });
    // The SAME client the soft-delete ran on — an enqueue on the pool would
    // survive a rolled-back delete.
    expect(txClients).toHaveLength(1);
    expect(enqueued[0].client).toBe(txClients[0]);

    const { rows } = await client.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM comments WHERE id = $1`, [id]);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it("the content author removing somebody else's reply still signs as the REPLY'S author", async () => {
    const writer = await account("Writer");
    const replier = await account("Replier");
    const { id } = await indexedReply(writer, replier);

    as(writer);
    const res = await app.inject({ method: "DELETE", url: `/replies/${id}` });
    expect(res.statusCode).toBe(200);
    expect(signEvent.mock.calls[0][0]).toBe(replier);
    expect(enqueued).toHaveLength(1);
  });

  it("a second delete of the same reply sends no second tombstone", async () => {
    const writer = await account("Writer");
    const replier = await account("Replier");
    const { id } = await indexedReply(writer, replier);
    as(replier);
    await app.inject({ method: "DELETE", url: `/replies/${id}` });
    signEvent.mockClear();
    enqueued.length = 0;

    const again = await app.inject({ method: "DELETE", url: `/replies/${id}` });
    expect(again.statusCode).toBe(200);
    expect(signEvent).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(0);
  });
});
