import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import pg from "pg";
import crypto from "crypto";

// =============================================================================
// An email change is recorded, announced to the address it replaced, undoable
// from there, and holds the key export while it can be undone (migration 273;
// CONSOLIDATED-TODO follow-up (f), operator ruling 2026-10-02).
//
// The attack is a chain: a stolen session moves the address, confirms it from
// the new mailbox, then asks for the key export — whose confirmation now goes
// to that same mailbox. Each case below asserts a fact about the DATABASE
// (what the account's email is, whether the token was spent, whether the hold
// row exists), never just the status code, because every refusal and every
// success here answers plausible JSON either way.
//
// WHY DB-BACKED. The guarantees are SQL: the row lock, the interval the hold
// is read over, the purpose CHECK the undo token is minted under, and the
// claim that must NOT run when the old address is taken. A mock dispatching on
// query text would agree with itself about all of them.
//
// Run locally (both variables — the shared pool reads DATABASE_URL only):
//   export DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub
//   TEST_DATABASE_URL="$DATABASE_URL" npx vitest run tests/email-change-undo.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.APP_URL = "https://test.all.haus";
process.env.STRIPE_SECRET_KEY ??= "sk_test_stub";
process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.INTERNAL_SECRET ??= "test-internal";

/** Whose session the request carries. Set per test, before the inject. */
let sessionSub = "";
const createSession = vi.fn(async () => "new-session");
const destroySession = vi.fn();
vi.mock("@platform-pub/shared/auth/session.js", () => ({
  verifySession: async () => (sessionSub ? { sub: sessionSub, iat: 1 } : null),
  createSession: (...a: unknown[]) => createSession(...(a as [])),
  destroySession: (...a: unknown[]) => destroySession(...(a as [])),
  refreshIfNeeded: async () => undefined,
}));

/** Every email sent; `failSends` makes the transport throw. */
const sent: { to: string; textBody: string; subject: string }[] = [];
let failSends = false;
const sendKeyExportStepUpEmail = vi.fn(async () => undefined);
vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendEmail: async (m: { to: string; textBody: string; subject: string }) => {
    if (failSends) throw new Error("postmark down");
    sent.push(m);
  },
  sendMagicLinkEmail: async () => undefined,
  sendKeyExportStepUpEmail: (...a: unknown[]) => sendKeyExportStepUpEmail(...(a as [])),
  sendKeyExportNoticeEmail: async () => undefined,
}));

const invalidateAuthCache = vi.fn();
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: sessionSub };
  },
  requireSelfServiceAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: sessionSub };
  },
  invalidateAuthCache: (...a: unknown[]) => invalidateAuthCache(...(a as [])),
}));

vi.mock("../src/middleware/admin.js", () => ({ getAdminIds: async () => [] }));
vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: vi.fn(),
  signEvent: vi.fn(),
  signEvents: vi.fn(),
  exportSecretKey: vi.fn(async () => ({ privkeyHex: "11".repeat(32), nsec: "nsec1test" })),
}));
vi.mock("../src/lib/discovery-publish.js", () => ({ republishProfile: vi.fn() }));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({ enqueueRelayPublish: vi.fn() }));
vi.mock("stripe", () => ({ default: vi.fn(() => ({})) }));

const { authRoutes } = await import("../src/routes/auth.js");
const { exportRoutes } = await import("../src/routes/export.js");
const { exportHold } = await import("../src/lib/email-change-hold.js");
const { requestStepUpToken } = await import("@platform-pub/shared/auth/magic-links.js");

const uniq = () => Math.random().toString(36).slice(2, 10);
const hex64 = () => crypto.randomBytes(32).toString("hex");
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

describe.skipIf(!DB_URL)("email change — record, notice, undo, export hold", () => {
  let client: pg.Client;
  const made: string[] = [];
  const app = Fastify();

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await app.register(authRoutes, { prefix: "/api/v1" });
    await app.register(exportRoutes, { prefix: "/api/v1" });
  });

  afterAll(async () => {
    if (made.length) await client.query(`DELETE FROM accounts WHERE id = ANY($1)`, [made]);
    await client.end();
    await app.close();
  });

  beforeEach(() => {
    sent.length = 0;
    failSends = false;
    sessionSub = "";
    createSession.mockClear();
    destroySession.mockClear();
    invalidateAuthCache.mockClear();
    sendKeyExportStepUpEmail.mockClear();
  });

  async function makeAccount(email: string | null = `ec_${uniq()}@example.com`) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, email, display_name, status, nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2, 'EC Tester', 'active', $3, 'not-a-real-blob')
       RETURNING id`,
      [`ec_${uniq()}`, email, hex64()],
    );
    made.push(rows[0].id);
    return rows[0].id;
  }

  /** Stage a pending change the way POST /auth/change-email leaves it. */
  async function stageChange(accountId: string, newEmail: string): Promise<string> {
    const token = crypto.randomBytes(32).toString("base64url");
    await client.query(
      `UPDATE accounts SET pending_email = $1, email_verification_token = $2,
              email_verification_requested_at = now() WHERE id = $3`,
      [newEmail, sha(token), accountId],
    );
    return token;
  }

  async function confirm(token: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email-change",
      payload: { token },
    });
  }

  async function account(id: string) {
    const { rows } = await client.query<{
      email: string | null;
      pending_email: string | null;
      email_verification_token: string | null;
      sessions_invalidated_at: Date | null;
    }>(
      `SELECT email, pending_email, email_verification_token, sessions_invalidated_at
         FROM accounts WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /** The change id and undo token, read out of the notice we sent. */
  function undoLinkFrom(mail: { textBody: string }) {
    const m = /undo-email-change\?change=([0-9a-f-]{36})&token=([A-Za-z0-9_-]+)/.exec(mail.textBody);
    if (!m) throw new Error(`no undo link in: ${mail.textBody}`);
    return { change: m[1], token: m[2] };
  }

  async function undo(change: string, token: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/undo-email-change",
      payload: { change, token },
    });
  }

  it("a confirmed change swaps the address, signs everyone out, records the old one and tells it", async () => {
    const oldEmail = `ec_old_${uniq()}@example.com`;
    const newEmail = `ec_new_${uniq()}@example.com`;
    const id = await makeAccount(oldEmail);
    const token = await stageChange(id, newEmail);

    const res = await confirm(token);
    expect(res.statusCode).toBe(200);

    const acc = await account(id);
    expect(acc.email).toBe(newEmail);
    expect(acc.pending_email).toBeNull();
    expect(acc.sessions_invalidated_at).not.toBeNull();
    expect(invalidateAuthCache).toHaveBeenCalledWith(id);

    const { rows: changes } = await client.query(
      `SELECT old_email, new_email, undone_at FROM account_email_changes WHERE account_id = $1`,
      [id],
    );
    expect(changes).toEqual([{ old_email: oldEmail, new_email: newEmail, undone_at: null }]);

    // The notice goes to the OLD address, and only there.
    expect(sent.map((m) => m.to)).toEqual([oldEmail]);
    expect(sent[0].textBody).not.toContain(newEmail);
    undoLinkFrom(sent[0]);
  });

  it("the confirming device keeps its session only if it already had one for this account", async () => {
    const id = await makeAccount();
    sessionSub = id;
    expect((await confirm(await stageChange(id, `ec_${uniq()}@example.com`))).statusCode).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);

    const other = await makeAccount();
    sessionSub = await makeAccount(); // somebody else's session in this browser
    expect((await confirm(await stageChange(other, `ec_${uniq()}@example.com`))).statusCode).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(destroySession).toHaveBeenCalled();
  });

  it("a notice that cannot be sent leaves the change undone and the link still good", async () => {
    const oldEmail = `ec_old_${uniq()}@example.com`;
    const newEmail = `ec_new_${uniq()}@example.com`;
    const id = await makeAccount(oldEmail);
    const token = await stageChange(id, newEmail);

    failSends = true;
    expect((await confirm(token)).statusCode).toBe(500);
    const acc = await account(id);
    expect(acc.email).toBe(oldEmail);
    expect(acc.email_verification_token).toBe(sha(token));
    const { rowCount } = await client.query(
      `SELECT 1 FROM account_email_changes WHERE account_id = $1`, [id]);
    expect(rowCount).toBe(0);
    // The undo token is minted on the transaction, so it rolled back too.
    const { rowCount: tokens } = await client.query(
      `SELECT 1 FROM magic_links WHERE account_id = $1 AND purpose = 'email_change_undo'`, [id]);
    expect(tokens).toBe(0);

    failSends = false;
    expect((await confirm(token)).statusCode).toBe(200);
    expect((await account(id)).email).toBe(newEmail);
  });

  it("the undo puts the old address back, signs everyone out, lifts the hold and spends export links", async () => {
    const oldEmail = `ec_old_${uniq()}@example.com`;
    const id = await makeAccount(oldEmail);
    await confirm(await stageChange(id, `ec_new_${uniq()}@example.com`));
    const { change, token } = undoLinkFrom(sent[0]);
    const before = (await account(id)).sessions_invalidated_at!;

    // An export confirmation the attacker asked for before the undo.
    await requestStepUpToken(id, "key_export");
    expect(await exportHold(id)).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    const res = await undo(change, token);
    expect(res.statusCode).toBe(200);

    const acc = await account(id);
    expect(acc.email).toBe(oldEmail);
    expect(acc.sessions_invalidated_at!.getTime()).toBeGreaterThan(before.getTime());
    expect(await exportHold(id)).toBeNull();
    const { rowCount } = await client.query(
      `SELECT 1 FROM magic_links WHERE account_id = $1 AND purpose = 'key_export' AND used_at IS NULL`,
      [id],
    );
    expect(rowCount).toBe(0);

    // Once only.
    expect((await undo(change, token)).statusCode).toBe(403);
  });

  it("a second change inside the window cannot move what the first undo restores", async () => {
    const original = `ec_orig_${uniq()}@example.com`;
    const id = await makeAccount(original);
    await confirm(await stageChange(id, `ec_a1_${uniq()}@example.com`));
    const first = undoLinkFrom(sent[0]);
    await confirm(await stageChange(id, `ec_a2_${uniq()}@example.com`));

    expect((await undo(first.change, first.token)).statusCode).toBe(200);
    expect((await account(id)).email).toBe(original);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM account_email_changes WHERE account_id = $1 AND undone_at IS NULL`,
      [id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses a wrong token, another change's token and another purpose's token alike, changing nothing", async () => {
    const id = await makeAccount();
    await confirm(await stageChange(id, `ec_new_${uniq()}@example.com`));
    const { change } = undoLinkFrom(sent[0]);
    const email = (await account(id)).email;

    const other = await makeAccount();
    await confirm(await stageChange(other, `ec_new_${uniq()}@example.com`));
    const otherLink = undoLinkFrom(sent[1]);
    const { token: exportToken } = await requestStepUpToken(id, "key_export");

    for (const token of ["nonsense", otherLink.token, exportToken]) {
      const res = await undo(change, token);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("undo_invalid");
    }
    expect((await undo("not-a-uuid", "x")).statusCode).toBe(403);
    expect((await account(id)).email).toBe(email);
  });

  it("an old address someone else now holds is said, and the token survives", async () => {
    const oldEmail = `ec_old_${uniq()}@example.com`;
    const id = await makeAccount(oldEmail);
    await confirm(await stageChange(id, `ec_new_${uniq()}@example.com`));
    const { change, token } = undoLinkFrom(sent[0]);
    const squatter = await makeAccount(oldEmail);

    expect((await undo(change, token)).statusCode).toBe(409);
    const { rowCount } = await client.query(
      `SELECT 1 FROM magic_links WHERE account_id = $1 AND purpose = 'email_change_undo' AND used_at IS NULL`,
      [id],
    );
    expect(rowCount).toBe(1);

    // Once the address is free again, the same link still works.
    await client.query(`UPDATE accounts SET email = NULL WHERE id = $1`, [squatter]);
    expect((await undo(change, token)).statusCode).toBe(200);
  });

  it("the export waits during the hold: no confirmation is mailed and a confirmation link is not spent", async () => {
    const id = await makeAccount();
    const { token: exportToken } = await requestStepUpToken(id, "key_export");
    await confirm(await stageChange(id, `ec_new_${uniq()}@example.com`));
    sessionSub = id;

    const req = await app.inject({ method: "POST", url: "/api/v1/account/export/request" });
    expect(req.statusCode).toBe(403);
    expect(req.json().error).toBe("export_held");
    expect(req.json().message).toMatch(/paused until/);
    expect(sendKeyExportStepUpEmail).not.toHaveBeenCalled();

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/account/export?token=${encodeURIComponent(exportToken)}`,
    });
    expect(get.statusCode).toBe(403);
    expect(get.json().error).toBe("export_held");
    const { rowCount } = await client.query(
      `SELECT 1 FROM magic_links WHERE token_hash = $1 AND used_at IS NULL`,
      [sha(exportToken)],
    );
    expect(rowCount).toBe(1);
    const { rowCount: exports } = await client.query(
      `SELECT 1 FROM account_key_exports WHERE account_id = $1`, [id]);
    expect(exports).toBe(0);
  });

  it("a change older than the hold no longer holds", async () => {
    const id = await makeAccount();
    await confirm(await stageChange(id, `ec_new_${uniq()}@example.com`));
    await client.query(
      `UPDATE account_email_changes SET changed_at = now() - interval '8 days' WHERE account_id = $1`,
      [id],
    );
    expect(await exportHold(id)).toBeNull();
    await client.query(
      `UPDATE account_email_changes SET changed_at = now() - interval '6 days' WHERE account_id = $1`,
      [id],
    );
    expect(await exportHold(id)).not.toBeNull();
  });
});
