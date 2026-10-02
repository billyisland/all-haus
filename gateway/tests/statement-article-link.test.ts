import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { buildStatementSQL } from "../src/routes/my-account.js";

// =============================================================================
// A STATEMENT LINE LINKS A PIECE ONLY WHERE ITS PAGE OPENS (MODERNHAUS-ADR §E7.3).
//
// Every read on the statement carried `/article/<dTag>`, and `GET
// /articles/:dTag` answers 404 where no row under that d-tag was ever
// published — so a read of a piece its writer had since unpublished linked
// both registers to "not found". A WITHDRAWN piece is the other case and must
// keep its link: the article page renders it for the readers who paid.
//
// DB-BACKED, because the condition is an EXISTS over `articles` that only
// Postgres evaluates. Always rolled back. Run locally (both vars):
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/statement-article-link.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const FEE = 800;

describe.skipIf(!DB_URL)("the statement's article links", () => {
  let client: pg.Client;
  let writerId: string;
  let readerId: string;

  let seq = 0;
  const uniq = () => `link-${Date.now().toString(36)}-${seq++}`;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  async function insertAccount(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, free_allowance_granted_pence, free_allowance_remaining_pence)
       VALUES ($1, 0, 0) RETURNING id`,
      [uniq().padEnd(64, "0")],
    );
    return rows[0].id;
  }

  beforeEach(async () => {
    await client.query("BEGIN");
    writerId = await insertAccount();
    readerId = await insertAccount();
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  /** An article read by the reader for 100p; returns its d-tag. */
  async function readOf(state: "published" | "never_published" | "withdrawn"): Promise<string> {
    const s = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug,
                             access_mode, price_pence, published_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, 'paywalled', 100, $6, $7) RETURNING id`,
      [
        writerId,
        s.padEnd(64, "0"),
        s,
        `Article ${s}`,
        s,
        state === "never_published" ? null : new Date(),
        state === "withdrawn" ? new Date() : null,
      ],
    );
    await client.query(
      `INSERT INTO read_events (reader_id, article_id, writer_id, amount_pence, state)
       VALUES ($1, $2, $3, 100, 'platform_settled')`,
      [readerId, rows[0].id, writerId],
    );
    return s;
  }

  async function linkFor(dTag: string, accountId = readerId): Promise<string | null | undefined> {
    const { rows } = await client.query<{ description: string; link: string | null }>(
      buildStatementSQL(true, "all"),
      [accountId, FEE],
    );
    const row = rows.find((r) => r.description.endsWith(`Article ${dTag}`));
    expect(row, `a line for ${dTag}`).toBeDefined();
    return row?.link;
  }

  it("links a published piece", async () => {
    const d = await readOf("published");
    expect(await linkFor(d)).toBe(`/article/${d}`);
  });

  it("offers no link to a piece that has no published row", async () => {
    const d = await readOf("never_published");
    expect(await linkFor(d)).toBeNull();
  });

  it("keeps the link to a WITHDRAWN piece, which the article page still renders for its readers", async () => {
    const d = await readOf("withdrawn");
    expect(await linkFor(d)).toBe(`/article/${d}`);
  });

  it("the writer's earning line follows the same rule", async () => {
    const d = await readOf("never_published");
    expect(await linkFor(d, writerId)).toBeNull();
  });
});
