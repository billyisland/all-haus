import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { PUBLICATION_MEMBER_ACCEPT_SQL } from "../src/routes/publications/members.js";
import { ROLE_DEFAULTS } from "../src/routes/publications/shared.js";

// =============================================================================
// An accepted invite writes the role AND the role's powers (MIRROR-AUDIT §3
// *Money*, S14).
//
// The accept upsert listed the five can_* columns in its INSERT and left them
// out of the DO UPDATE, so a resurrected member kept the powers they held when
// they left: a removed editor-in-chief re-invited as a contributor came back
// with can_manage_members and can_manage_finances while `role` read
// 'contributor'. requirePublicationPermission reads the columns, not the label,
// so that is a live finance mandate on a publication's money routes.
//
// WHY DB-BACKED. Which columns survive an ON CONFLICT DO UPDATE is Postgres's
// answer to this exact statement — the pre-fix and post-fix routes issue the
// same call with the same parameters and differ only in the text. A mocked
// `pool.query` hands back its fixture either way. So this runs the REAL
// exported statement, with the REAL ROLE_DEFAULTS the route passes it.
//
// Rows are seeded inside a transaction that is ALWAYS rolled back.
//
// Skipped unless a DB URL is supplied — CI supplies one (it boots Postgres and
// FAILS on a skip). Run locally against the dev DB:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/publication-invite-accept-permissions.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

type Role = keyof typeof ROLE_DEFAULTS;

describe.skipIf(!DB_URL)("invite acceptance — permissions follow the role", () => {
  let client: pg.Client;
  let pubId: string;
  let accountId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    pubId = await insertPublication();
    accountId = await insertAccount();
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  let seq = 0;
  const uniq = () => `s14m-${Date.now().toString(36)}-${seq++}`;

  async function insertAccount(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, "0")],
    );
    return rows[0].id;
  }

  async function insertPublication(): Promise<string> {
    const s = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO publications (slug, name, nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [s, `Pub ${s}`, s.padEnd(64, "0"), "enc"],
    );
    return rows[0].id;
  }

  /** Exactly what the route does with a validated invite. */
  const accept = (role: Role, contributorType = "permanent") => {
    const perms = ROLE_DEFAULTS[role];
    return client.query(PUBLICATION_MEMBER_ACCEPT_SQL, [
      pubId, accountId, role, contributorType,
      perms.can_publish, perms.can_edit_others, perms.can_manage_members,
      perms.can_manage_finances, perms.can_manage_settings,
    ]);
  };

  const read = async () =>
    (
      await client.query<{
        role: string; can_publish: boolean; can_edit_others: boolean;
        can_manage_members: boolean; can_manage_finances: boolean;
        can_manage_settings: boolean; revenue_share_bps: number;
        removed_at: Date | null;
      }>(
        `SELECT role, can_publish, can_edit_others, can_manage_members,
                can_manage_finances, can_manage_settings, revenue_share_bps, removed_at
           FROM publication_members WHERE publication_id = $1 AND account_id = $2`,
        [pubId, accountId],
      )
    ).rows[0];

  const remove = () =>
    client.query(
      `UPDATE publication_members SET removed_at = now()
        WHERE publication_id = $1 AND account_id = $2`,
      [pubId, accountId],
    );

  it("grants the role's defaults on a first acceptance", async () => {
    await accept("editor_in_chief");
    expect(await read()).toMatchObject({ role: "editor_in_chief", ...ROLE_DEFAULTS.editor_in_chief });
  });

  it("a removed editor-in-chief re-invited as a CONTRIBUTOR loses the manager powers", async () => {
    // THE finding. Pre-fix this row came back can_manage_members = TRUE and
    // can_manage_finances = TRUE under the label 'contributor'.
    await accept("editor_in_chief");
    await remove();
    await accept("contributor");

    expect(await read()).toMatchObject({
      role: "contributor",
      ...ROLE_DEFAULTS.contributor,
      removed_at: null,
    });
  });

  it("still zeroes a resurrected member's stale revenue share (F10, unchanged)", async () => {
    await accept("editor");
    await client.query(
      `UPDATE publication_members SET revenue_share_bps = 4000
        WHERE publication_id = $1 AND account_id = $2`,
      [pubId, accountId],
    );
    await remove();
    await accept("contributor");
    expect((await read()).revenue_share_bps).toBe(0);
  });

  it("leaves an ACTIVE member's revenue share alone (F10, unchanged)", async () => {
    await accept("editor");
    await client.query(
      `UPDATE publication_members SET revenue_share_bps = 4000
        WHERE publication_id = $1 AND account_id = $2`,
      [pubId, accountId],
    );
    await accept("editor");
    expect((await read()).revenue_share_bps).toBe(4000);
  });

  it("an UPGRADE invite confers the powers, not just the label", async () => {
    // The other half of the same defect: the label 'editor_in_chief' gates
    // ownership-transfer eligibility, so a row carrying it with a contributor's
    // powers is a lie in the generous direction too.
    await accept("contributor");
    await accept("editor_in_chief");
    expect(await read()).toMatchObject({ role: "editor_in_chief", ...ROLE_DEFAULTS.editor_in_chief });
  });
});
