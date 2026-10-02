import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";

// =============================================================================
// deleteBlob — the blob is shared and the row is per-uploader (L7.2).
//
// Media is content-addressed: two members who post the same picture get the
// same sha256 and the same stored blob. So a delete asks two questions, and
// only one of them is "is this yours". The other is whether anybody ELSE is
// using these bytes — and if they are, the row goes and the blob stays, or one
// member's erasure silently breaks another member's post.
//
// WHY DB-BACKED. The whole of the refusal is `uploader_id <> $2` in a count,
// against rows storeImage writes. A mocked `pool.query` would hand back
// whichever count the fixture holds and agree with itself either way — and the
// second half of the fix is storeImage recording a row for the SECOND uploader
// at all, which until L7.2 it did not, leaving nothing for this predicate to
// see. A mock cannot tell those two states apart; the table can.
//
// THE ASSERTION IS WHETHER BLOSSOM WAS CALLED, never the return value alone. A
// refusal that still issued the DELETE would be the finding again wearing a
// different word.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/media-blob-delete.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// The signer answers with the pubkey the account publishes under, as
// key-custody does — unless a case says otherwise. The 403 arm asks whether the
// refused event was signed by THAT key (§0ab guard (e)), so a mock that omits
// the pubkey would test nothing but the refusal.
const pubkeyOf = new Map<string, string>();
let signAs: string | null = null;
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: async (signerId: string) => ({
    id: "auth",
    sig: "sig",
    kind: 24242,
    pubkey: signAs ?? pubkeyOf.get(signerId),
  }),
}));

import { deleteBlob } from "../src/services/media-store.js";

const uniq = () => Math.random().toString(36).slice(2, 10);
const hex64 = () =>
  Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

describe.skipIf(!DB_URL)("deleteBlob", () => {
  let client: pg.Client;
  const accounts: string[] = [];
  let alice = "";
  let bob = "";
  let blossomCalls: { url: string; method: string }[] = [];

  async function makeAccount(): Promise<string> {
    const u = `l72_${uniq()}`;
    const pubkey = hex64();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, email, display_name, status, nostr_pubkey)
       VALUES ($1, $2, 'L7.2 Tester', 'active', $3) RETURNING id`,
      [u, `${u}@example.com`, pubkey],
    );
    accounts.push(rows[0].id);
    pubkeyOf.set(rows[0].id, pubkey);
    return rows[0].id;
  }

  async function upload(uploaderId: string, sha: string) {
    await client.query(
      `INSERT INTO media_uploads (uploader_id, blossom_url, sha256, mime_type, size_bytes)
       VALUES ($1, $2, $3, 'image/webp', 1)`,
      [uploaderId, `https://example.test/media/${sha}.webp`, sha],
    );
  }

  async function rowsFor(sha: string): Promise<string[]> {
    const { rows } = await client.query<{ uploader_id: string }>(
      "SELECT uploader_id FROM media_uploads WHERE sha256 = $1",
      [sha],
    );
    return rows.map((r) => r.uploader_id);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    alice = await makeAccount();
    bob = await makeAccount();
  });

  afterAll(async () => {
    if (!client) return;
    for (const id of accounts) {
      await client.query("DELETE FROM media_uploads WHERE uploader_id = $1", [id]);
      await client.query("DELETE FROM accounts WHERE id = $1", [id]);
    }
    await client.end();
  });

  beforeEach(() => {
    blossomCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        blossomCalls.push({ url: String(url), method: init?.method ?? "GET" });
        return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
      }),
    );
  });

  it("keeps a blob two members hold, and removes only the asker's row", async () => {
    const sha = hex64();
    await upload(alice, sha);
    await upload(bob, sha);

    const result = await deleteBlob(sha, alice);

    expect(result.outcome).toBe("shared");
    // The whole finding: Bob's picture must still load.
    expect(blossomCalls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(await rowsFor(sha)).toEqual([bob]);
  });

  it("deletes the blob when the asker is the only holder", async () => {
    const sha = hex64();
    await upload(alice, sha);

    const result = await deleteBlob(sha, alice);

    expect(result.outcome).toBe("deleted");
    const del = blossomCalls.filter((c) => c.method === "DELETE");
    expect(del).toHaveLength(1);
    expect(del[0].url).toContain(sha);
    expect(await rowsFor(sha)).toEqual([]);
  });

  it("refuses a hash that is not the asker's, and touches nothing", async () => {
    const sha = hex64();
    await upload(bob, sha);

    const result = await deleteBlob(sha, alice);

    expect(result.outcome).toBe("not_yours");
    expect(blossomCalls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(await rowsFor(sha)).toEqual([bob]);
  });

  it("keeps the row when Blossom refuses the delete", async () => {
    // The table must never claim a blob the store does not have, and must never
    // forget one the store still does — storeImage's verify-before-INSERT read
    // backwards. A failed DELETE rolls the row back.
    const sha = hex64();
    await upload(alice, sha);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => "down" })),
    );

    await expect(deleteBlob(sha, alice)).rejects.toThrow(/Blossom delete failed/);
    expect(await rowsFor(sha)).toEqual([alice]);
  });

  it("a 403 — Blossom's owner is an earlier uploader — removes the row and names the orphan (§0z 17b)", async () => {
    // A uploads, B posts the same bytes (a row, no upload — Blossom's owner
    // table names A alone), A deletes theirs (`shared`), B is erased: B is
    // the sole DB holder, Blossom refuses B's signature. Pre-fix: thrown as
    // `unavailable`, the row rolled back, the erasure `failed` on every re-run.
    const sha = hex64();
    await upload(alice, sha);
    stubBlossom403("You are not an owner of this blob");
    const r = await deleteBlob(sha, alice);
    expect(r.outcome).toBe("orphaned_at_blossom");
    expect(await rowsFor(sha)).toEqual([]);
  });

  // §0ab guard (e): blossom-server answers 403 for three reasons, and two of
  // them are our auth event being wrong. Read as "shared", each orphaned the
  // blob with a clean exit and let the erasure blank the key a re-run needs.
  it.each([
    'Auth token type "upload" does not match required "delete"',
    "Auth token does not authorize operation on blob 00ff",
    "",
  ])("a 403 whose reason is OURS (%j) throws and keeps the row", async (reason) => {
    const sha = hex64();
    await upload(alice, sha);
    stubBlossom403(reason);
    await expect(deleteBlob(sha, alice)).rejects.toThrow(/Blossom delete refused/);
    expect(await rowsFor(sha)).toEqual([alice]);
  });

  it("an ownership 403 on an event signed by ANOTHER key is ours, not an orphan", async () => {
    // "Not an owner" is also what the wrong key earns — a custody fault, not
    // a blob somebody else uploaded first.
    const sha = hex64();
    await upload(alice, sha);
    stubBlossom403("You are not an owner of this blob");
    signAs = hex64();
    try {
      await expect(deleteBlob(sha, alice)).rejects.toThrow(/not the uploader's/);
    } finally {
      signAs = null;
    }
    expect(await rowsFor(sha)).toEqual([alice]);
  });

  function stubBlossom403(reason: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: new Headers(reason ? { "X-Reason": reason } : {}),
        text: async () => reason,
      })),
    );
  }
});
