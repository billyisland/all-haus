import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import pg from "pg";
import { insertNostrItem, type NostrEvent } from "./nostr-ingest.js";
import { insertActivityPubItem } from "./activitypub-ingest.js";
import { insertEmailItem } from "./email-ingest.js";
import { REFRESH_EXTERNAL_AUTHOR_SQL } from "../tasks/feed-items-author-refresh.js";
import type { NormalisedActivityPubItem } from "../adapters/activitypub.js";
import type { NormalisedEmailItem } from "../adapters/email.js";

// =============================================================================
// An ingester writes the SAME author name to both columns (MIRROR-AUDIT §3
// *Data integrity and ingest*, S17).
//
// `feed_items.author_name` is the item's own author name or NULL (migration
// 184, BYLINE-AND-PROVENANCE-ADR D9 ⟂), and the nightly maintainers repair it
// from `NULLIF(external_items.author_name, '')`. So the two columns are one
// value in two places, and an ingester that computes them differently makes the
// system flap: `feed_items_author_refresh` rewrites the row at 04:00, and the
// next re-ingest of a replaceable kind writes it straight back. Every night,
// for ever, with the nightly pass reporting drift it caused itself.
//
// Three ingesters disagreed. nostr and activitypub resolved through
// `source.display_name` for external_items and NOT for feed_items (nostr also
// substituting the literal "Unknown" that migration 184 exists to remove);
// email did the same, and there the fallback was wrong in BOTH columns — an
// email source is a PUBLICATION, so a From-less issue recorded the newsletter
// as the author, which is D9's exact trap and reaches past the byline into the
// tier-C identity mint (`<source_id>#<name>`).
//
// THE ASSERTION IS THAT THE NIGHTLY PASS HAS NOTHING TO DO. That is the
// invariant stated as a fact about the system rather than as a restatement of
// either expression — a test comparing the ingester against a copy of its own
// SQL would agree with itself. `REFRESH_EXTERNAL_AUTHOR_SQL` is imported from
// the task, not transcribed.
//
// Mutation-proved: restoring `?? source.display_name` on either dual-write in
// nostr-ingest.ts or activitypub-ingest.ts, or `|| source.display_name` in
// email-ingest.ts, makes the refresh update a row and fails the pair.
//
// Runs the REAL writers against a live Postgres, in a transaction that is
// ALWAYS rolled back. Skipped unless a DB URL is supplied — CI supplies one and
// fails on a skip. Locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/lib/ingest-author-name-agreement.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// The source's own name. If it ever appears as an author name the fallback is
// back — for email that is the defect outright, for nostr/activitypub it is
// only legitimate because one source there IS one author, and then it must
// appear in BOTH columns.
const SOURCE_NAME = "The Sunday Dispatch";

describe.skipIf(!DB_URL)(
  "an ingester writes one author name to both columns (S17)",
  () => {
    let pool: pg.Pool;
    let client: pg.PoolClient;
    let seq = 0;
    const uniq = () => `s17-${Date.now().toString(36)}-${seq++}`;

    beforeAll(() => {
      pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
    });
    afterAll(async () => {
      await pool.end();
    });
    beforeEach(async () => {
      client = await pool.connect();
      await client.query("BEGIN");
    });
    afterEach(async () => {
      await client.query("ROLLBACK");
      client.release();
    });

    async function createSource(protocol: string, sourceUri: string) {
      const { rows } = await client.query(
        `INSERT INTO external_sources (protocol, source_uri, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, source_uri, handle, display_name, avatar_url`,
        [protocol, sourceUri, SOURCE_NAME],
      );
      return rows[0];
    }

    /** Both spellings of the one value, read back from the two tables. */
    async function names(uri: string) {
      const { rows } = await client.query(
        `SELECT ei.author_name AS ei_name, fi.author_name AS fi_name
           FROM external_items ei
           JOIN feed_items fi ON fi.external_item_id = ei.id
          WHERE ei.source_item_uri = $1`,
        [uri],
      );
      expect(rows).toHaveLength(1);
      return rows[0] as { ei_name: string | null; fi_name: string | null };
    }

    /**
     * What the 04:00 maintainer would do to the rows this test just wrote.
     *
     * The task's own statement, imported rather than transcribed, with ONE
     * mechanical narrowing appended to its WHERE so the count is about the
     * fixtures. It has to be narrowed: unfiltered it is an UPDATE over every
     * external row in the database, which on a dev database means it both
     * reports pre-existing drift as this test's (the first run of this suite
     * found 307 such rows — the defect itself, sitting there) and takes row
     * locks the rest of the suite deadlocks against.
     *
     * Nothing in the imported text is altered, so a drift in the expression
     * under test still shows up here.
     */
    async function nightlyRepairs(sourceId: string): Promise<number> {
      const res = await client.query(
        `${REFRESH_EXTERNAL_AUTHOR_SQL}\n      AND fi.source_id = $1`,
        [sourceId],
      );
      return res.rowCount ?? 0;
    }

    // ── nostr ───────────────────────────────────────────────────────────────
    // normaliseNostrEvent always yields authorName null (a relay event carries
    // no name), so the source chain is the ONLY name a nostr row can have — and
    // it is the author's, one source being one pubkey.

    it("nostr: both columns carry the resolved name, and the nightly pass is a no-op", async () => {
      const pubkey = "a".repeat(64);
      const source = await createSource("nostr_external", pubkey);
      const event: NostrEvent = {
        id: "b".repeat(64),
        pubkey,
        created_at: 1_750_000_000,
        kind: 1,
        tags: [],
        content: "a note with no name on it",
        sig: "f".repeat(128),
      };

      expect(
        await insertNostrItem(client, source, event, {
          relays: [],
          sourceNip05: null,
        }),
      ).toBe("inserted");

      const uri = (
        await client.query(
          `SELECT source_item_uri FROM external_items WHERE source_id = $1`,
          [source.id],
        )
      ).rows[0].source_item_uri as string;

      const { ei_name, fi_name } = await names(uri);
      expect(ei_name).toBe(SOURCE_NAME);
      expect(fi_name).toBe(SOURCE_NAME); // NOT null — the halves must agree
      expect(await nightlyRepairs(source.id)).toBe(0);
    });

    it("nostr: a source with no display_name lands NULL, never the literal 'Unknown'", async () => {
      const pubkey = "c".repeat(64);
      const { rows } = await client.query(
        `INSERT INTO external_sources (protocol, source_uri, display_name)
         VALUES ('nostr_external', $1, NULL)
         RETURNING id, source_uri, handle, display_name, avatar_url`,
        [pubkey],
      );
      const source = rows[0];
      const event: NostrEvent = {
        id: "d".repeat(64),
        pubkey,
        created_at: 1_750_000_100,
        kind: 1,
        tags: [],
        content: "nameless",
        sig: "f".repeat(128),
      };
      await insertNostrItem(client, source, event, {
        relays: [],
        sourceNip05: null,
      });

      const uri = (
        await client.query(
          `SELECT source_item_uri FROM external_items WHERE source_id = $1`,
          [source.id],
        )
      ).rows[0].source_item_uri as string;

      const { ei_name, fi_name } = await names(uri);
      expect(ei_name).toBeNull();
      expect(fi_name).toBeNull();
      expect(await nightlyRepairs(source.id)).toBe(0);
    });

    // ── activitypub ─────────────────────────────────────────────────────────

    it("activitypub: both columns carry the resolved name, and the nightly pass is a no-op", async () => {
      const actor = `https://example.social/users/${uniq()}`;
      const source = await createSource("activitypub", actor);
      const uri = `${actor}/statuses/1`;
      const item: NormalisedActivityPubItem = {
        sourceItemUri: uri,
        title: null,
        authorName: null, // the actor document carried no `name`
        authorHandle: "someone@example.social",
        authorAvatarUrl: null,
        authorUri: actor,
        contentText: "a status",
        contentHtml: "<p>a status</p>",
        language: null,
        media: [],
        sourceReplyUri: null,
        sourceQuoteUri: null,
        contentWarning: null,
        publishedAt: new Date("2026-01-01T00:00:00Z"),
        webUrl: null,
        interactionData: { id: uri },
      };

      expect(await insertActivityPubItem(client, source, item)).toBe(true);

      const { ei_name, fi_name } = await names(uri);
      expect(ei_name).toBe(SOURCE_NAME);
      expect(fi_name).toBe(SOURCE_NAME);
      expect(await nightlyRepairs(source.id)).toBe(0);
    });

    it("activitypub: the item's own name wins and reaches both columns", async () => {
      const actor = `https://example.social/users/${uniq()}`;
      const source = await createSource("activitypub", actor);
      const uri = `${actor}/statuses/2`;
      await insertActivityPubItem(client, source, {
        sourceItemUri: uri,
        title: null,
        authorName: "Ada Lovelace",
        authorHandle: "ada@example.social",
        authorAvatarUrl: null,
        authorUri: actor,
        contentText: "a status",
        contentHtml: "<p>a status</p>",
        language: null,
        media: [],
        sourceReplyUri: null,
        sourceQuoteUri: null,
        contentWarning: null,
        publishedAt: new Date("2026-01-02T00:00:00Z"),
        webUrl: null,
        interactionData: { id: uri },
      });

      const { ei_name, fi_name } = await names(uri);
      expect(ei_name).toBe("Ada Lovelace");
      expect(fi_name).toBe("Ada Lovelace");
      expect(await nightlyRepairs(source.id)).toBe(0);
    });

    // ── email ───────────────────────────────────────────────────────────────
    // The opposite ruling, and the one that matters: an email source is a
    // publication, not a person. A From-less issue names NOBODY.

    it("email: a From-less issue names nobody — not the newsletter", async () => {
      const source = await createSource("email", `${uniq()}@inbound.example`);
      const uri = `email:${uniq()}`;
      const item: NormalisedEmailItem = {
        sourceItemUri: uri,
        title: "Issue 42",
        authorName: "", // normaliseEmail's shape for a missing From
        authorHandle: "issues@example.com",
        contentText: "the body",
        contentHtml: "<p>the body</p>",
        canonicalUrl: null,
        media: [],
        publishedAt: new Date("2026-01-03T00:00:00Z"),
      };

      expect(await insertEmailItem(client, source, item)).toBe(true);

      const { ei_name, fi_name } = await names(uri);
      expect(ei_name).toBeNull();
      expect(fi_name).toBeNull();
      expect(await nightlyRepairs(source.id)).toBe(0);
    });

    it("email: a From-less issue mints no tier-C author named after the source", async () => {
      // The reach beyond the byline: the feed_items identity trigger mints
      // `<source_id>#<name>` for rss/email rows that carry a name, so the old
      // fallback made "The Sunday Dispatch" an AUTHOR of its own newsletter.
      const source = await createSource("email", `${uniq()}@inbound.example`);
      const uri = `email:${uniq()}`;
      await insertEmailItem(client, source, {
        sourceItemUri: uri,
        title: "Issue 43",
        authorName: "",
        authorHandle: "issues@example.com",
        contentText: "the body",
        contentHtml: "<p>the body</p>",
        canonicalUrl: null,
        media: [],
        publishedAt: new Date("2026-01-04T00:00:00Z"),
      });

      const { rows } = await client.query(
        `SELECT fi.external_author_id
           FROM feed_items fi
           JOIN external_items ei ON ei.id = fi.external_item_id
          WHERE ei.source_item_uri = $1`,
        [uri],
      );
      expect(rows[0].external_author_id).toBeNull();
      const { rowCount } = await client.query(
        `SELECT 1 FROM external_authors WHERE source_id = $1`,
        [source.id],
      );
      expect(rowCount).toBe(0);
    });

    it("email: a real From name reaches both columns unchanged", async () => {
      const source = await createSource("email", `${uniq()}@inbound.example`);
      const uri = `email:${uniq()}`;
      await insertEmailItem(client, source, {
        sourceItemUri: uri,
        title: "Issue 44",
        authorName: "Grace Hopper",
        authorHandle: "grace@example.com",
        contentText: "the body",
        contentHtml: "<p>the body</p>",
        canonicalUrl: null,
        media: [],
        publishedAt: new Date("2026-01-05T00:00:00Z"),
      });

      const { ei_name, fi_name } = await names(uri);
      expect(ei_name).toBe("Grace Hopper");
      expect(fi_name).toBe("Grace Hopper");
      expect(await nightlyRepairs(source.id)).toBe(0);
    });
  },
);
