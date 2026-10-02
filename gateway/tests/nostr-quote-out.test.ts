import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

// =============================================================================
// A QUOTE OF AN EXTERNAL NOSTR POST REACHES THAT POST'S RELAYS (CA-I13).
//
// `POST /notes` has long had an outbound branch that replays the note's signed
// event onto a quoted nostr_external item's relays — but it only ran when the
// body carried `signedEvent` AND a hex `quotedEventId`, and the web quotes an
// external post by its POST ID and never sent the event. So quoting a Nostr
// post from all.haus never left all.haus, while replying to one did.
//
// The web now sends both (the note q-tags the event it quotes), and the route
// resolves the item by post id. What is under test is the GUARD as much as the
// wiring: `signedEvent` is client-supplied and the worker publishes it verbatim
// onto third-party relays, so it is replayed only when it IS the note being
// indexed, signed by the member indexing it. Each hostile case below has the
// valid case as its control, and each asserts on the ENQUEUE — the note is
// indexed either way, so a status code cannot tell them apart.
// =============================================================================

const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const QUOTED_POST = "p".repeat(64);
const EXTERNAL_ITEM = "00000000-0000-4000-8000-0000000000e1";

const sk = generateSecretKey();
const PUBKEY = getPublicKey(sk);

let calls: Array<{ sql: string; params: unknown[] }> = [];
const enqueueNostrOutbound = vi.fn();

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  if (sql.includes("INSERT INTO notes")) {
    return Promise.resolve({ rows: [{ id: "note-1" }], rowCount: 1 });
  }
  if (sql.includes("FROM accounts")) {
    return Promise.resolve({
      rows: [{ display_name: "A", avatar_blossom_url: null, username: "a" }],
      rowCount: 1,
    });
  }
  // The quoted item, found by its post id through its feed card — answered
  // from the PARAM, so a lookup by anything else finds nothing.
  if (sql.includes("FROM feed_items fi") && sql.includes("fi.post_id = $1")) {
    const hit = params[0] === QUOTED_POST;
    return Promise.resolve({ rows: hit ? [{ id: EXTERNAL_ITEM }] : [], rowCount: hit ? 1 : 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/mentions.js", () => ({ resolveMentionedAccountIds: async () => [] }));
vi.mock("../src/lib/outbound-enqueue.js", () => ({
  enqueueCrossPost: vi.fn(),
  enqueueNostrOutbound: (...a: unknown[]) => enqueueNostrOutbound(...a),
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string; pubkey: string } }) => {
    req.session = { sub: AUTHOR, pubkey: PUBKEY };
  },
}));

const { noteRoutes } = await import("../src/routes/notes.js");

const CONTENT = "worth reading\n\nhttps://njump.me/nevent1example";

function signed(secret: Uint8Array = sk, content = CONTENT) {
  return finalizeEvent(
    { kind: 1, created_at: 1_700_000_000, content, tags: [["q", "e".repeat(64), "", "d".repeat(64)]] },
    secret,
  );
}

async function post(body: Record<string, unknown>) {
  const app = Fastify();
  await app.register(noteRoutes);
  const res = await app.inject({ method: "POST", url: "/notes", payload: body });
  await app.close();
  return res;
}

function quoteBody(ev: ReturnType<typeof signed>, over: Record<string, unknown> = {}) {
  return {
    nostrEventId: ev.id,
    content: CONTENT,
    isQuoteComment: true,
    quotedPostId: QUOTED_POST,
    quotedUrl: "https://njump.me/nevent1example",
    signedEvent: ev,
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  enqueueNostrOutbound.mockReset();
});

describe("POST /notes — a quote of an external Nostr post goes out", () => {
  it("replays the author's own signed note onto the quoted item's source", async () => {
    const ev = signed();
    const res = await post(quoteBody(ev));
    expect(res.statusCode).toBe(201);
    expect(enqueueNostrOutbound).toHaveBeenCalledOnce();
    const job = enqueueNostrOutbound.mock.calls[0][0];
    expect(job).toMatchObject({
      accountId: AUTHOR,
      sourceItemId: EXTERNAL_ITEM,
      nostrEventId: ev.id,
      actionType: "quote",
    });
    expect(job.signedEvent.id).toBe(ev.id);
  });

  it("does not replay an event signed by somebody else", async () => {
    const ev = signed(generateSecretKey());
    const res = await post(quoteBody(ev));
    expect(res.statusCode).toBe(201);
    expect(enqueueNostrOutbound).not.toHaveBeenCalled();
  });

  it("does not replay an event whose signature does not verify", async () => {
    const ev = { ...signed(), content: "something else entirely" };
    await post(quoteBody(ev));
    expect(enqueueNostrOutbound).not.toHaveBeenCalled();
  });

  it("does not replay an event that is not the note being indexed", async () => {
    const other = signed(sk, "a different note");
    await post(quoteBody(other, { nostrEventId: signed().id }));
    expect(enqueueNostrOutbound).not.toHaveBeenCalled();
  });

  it("sends nothing out for a quote that carries no signed event", async () => {
    const ev = signed();
    const { signedEvent: _drop, ...body } = quoteBody(ev);
    await post(body);
    expect(enqueueNostrOutbound).not.toHaveBeenCalled();
  });

  it("sends nothing out when the quoted post is not a relayed Nostr item", async () => {
    await post(quoteBody(signed(), { quotedPostId: "q".repeat(64) }));
    expect(enqueueNostrOutbound).not.toHaveBeenCalled();
  });
});
