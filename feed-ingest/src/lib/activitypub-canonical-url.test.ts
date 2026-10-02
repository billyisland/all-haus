import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// An item's IDENTITY is not its PERMALINK (the URL rule), for activitypub.
//
// `insertActivityPubItem` never named `canonical_url`, so the permalink the
// adapter reads off every object went into `interaction_data` and nowhere else:
// 0 of 58,686 rows carried one. The reader DERIVES a url from the id when the
// column is empty, and for Mastodon the derivation usually lands — which is
// why this was invisible, and why the test has to assert on the STATEMENT
// rather than on anything a reader would show.
//
// The mock answers from the SQL it is handed and hands out copies, so a test
// that stopped exercising the real statement would fail rather than pin itself.
// =============================================================================

const queries: { sql: string; params: unknown[] }[] = [];

function mockClient(opts: { conflict?: boolean } = {}) {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("INSERT INTO external_items")) {
        // `conflict` = the row exists and is already REAL, so the promotion
        // arm's WHERE refuses it and nothing is returned.
        return opts.conflict
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: "ext-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

const { insertActivityPubItem } = await import("./activitypub-ingest.js");

const SOURCE = {
  id: "src-1",
  source_uri: "https://m.example/users/alice",
  display_name: "Alice",
  avatar_url: null,
};

function item(over: Record<string, unknown> = {}) {
  return {
    sourceItemUri: "https://m.example/users/alice/statuses/1",
    title: null,
    authorName: null,
    authorHandle: "alice@m.example",
    authorAvatarUrl: null,
    authorUri: "https://m.example/users/alice",
    contentText: "hello",
    contentHtml: "<p>hello</p>",
    language: "en",
    media: [],
    sourceReplyUri: null,
    sourceQuoteUri: null,
    contentWarning: null,
    publishedAt: new Date("2026-09-01T10:00:00Z"),
    webUrl: "https://m.example/@alice/1",
    interactionData: { id: "https://m.example/users/alice/statuses/1" },
    ...over,
  } as never;
}

const insertSql = () =>
  queries.find((q) => q.sql.includes("INSERT INTO external_items"))!;

// THE ASSERTION HAS TO BIND THE COLUMN TO THE PARAMETER.
//
// The first draft checked `sql` matched /canonical_url/ and `params` contained
// the url — and BOTH survived deleting the column from the INSERT, because the
// name still appears in the ON CONFLICT arm and the now-unused value still sat
// in the params array. It passed against the defect verbatim; the mutation is
// what said so.
//
// So: read the column list, read the VALUES tuple, zip them, and resolve the
// placeholder through `params`. That cannot pass unless the value really is
// bound to that column.
function insertedValueFor(column: string): unknown {
  const q = insertSql();
  const m = q.sql.match(
    /INSERT INTO external_items \s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/,
  );
  if (!m) throw new Error("could not parse the INSERT");
  const columns = m[1].split(",").map((c) => c.trim());
  const values = m[2].split(",").map((v) => v.trim());
  expect(columns).toHaveLength(values.length);
  const i = columns.indexOf(column);
  if (i === -1) throw new Error(`column ${column} is not in the INSERT`);
  const token = values[i];
  const ref = token.match(/^\$(\d+)$/);
  // A literal in the VALUES tuple (like 'activitypub') is returned as written.
  return ref ? q.params[Number(ref[1]) - 1] : token;
}

beforeEach(() => {
  queries.length = 0;
});

describe("insertActivityPubItem — the permalink reaches the column", () => {
  it("writes canonical_url, and it is NOT the same string as the identity", async () => {
    const client = mockClient();
    await insertActivityPubItem(client as never, SOURCE, item());

    expect(insertedValueFor("canonical_url")).toBe("https://m.example/@alice/1");

    // The whole point of the column: it must not be the identity. Storing the
    // id here would pass a looser test while carrying exactly what the
    // reader's fallback already derives, i.e. buying nothing.
    expect(insertedValueFor("canonical_url")).not.toBe(
      insertedValueFor("source_item_uri"),
    );
  });

  it("leaves it NULL when the object declares no url", async () => {
    const client = mockClient();
    await insertActivityPubItem(client as never, SOURCE, item({ webUrl: null }));
    // NULL means "this object declared no url", never "there is none" — the
    // reader's derivation is what covers that case. `undefined` would reach
    // Postgres as NULL too, but it is the shape that says nobody decided.
    expect(insertedValueFor("canonical_url")).toBeNull();
  });

  it("refuses a non-http url at the write site rather than storing it", async () => {
    const client = mockClient();
    await insertActivityPubItem(
      client as never,
      SOURCE,
      item({ webUrl: "javascript:alert(1)" }),
    );
    // A stored url is rendered as an href. `httpUrlOrNull` is the refusal the
    // URL rule asks for, and it belongs here, at the write.
    expect(insertedValueFor("canonical_url")).toBeNull();
  });

  it("fills the permalink on a row that already exists, without overwriting", async () => {
    const client = mockClient({ conflict: true });
    const inserted = await insertActivityPubItem(client as never, SOURCE, item());

    // The conflict arm refused it, so the caller still reports "not new".
    expect(inserted).toBe(false);

    // ...but the historical row is healed beside the insert, fill-only. This
    // is the entire pre-existing corpus's only route back other than the
    // migration.
    const fill = queries.find((q) => q.sql.includes("UPDATE external_items"));
    expect(fill).toBeDefined();
    expect(fill!.sql).toMatch(/canonical_url IS NULL/);
    expect(fill!.params).toEqual([
      "https://m.example/users/alice/statuses/1",
      "https://m.example/@alice/1",
    ]);
  });

  it("does not issue a pointless fill when there is no url to fill with", async () => {
    const client = mockClient({ conflict: true });
    await insertActivityPubItem(client as never, SOURCE, item({ webUrl: null }));
    expect(queries.find((q) => q.sql.includes("UPDATE external_items"))).toBeUndefined();
  });

  it("keeps the promotion arm fill-only, never a clobber", async () => {
    const client = mockClient();
    await insertActivityPubItem(client as never, SOURCE, item());
    // A promoted context row may already hold a permalink from a richer fetch.
    expect(insertSql().sql).toMatch(
      /canonical_url = COALESCE\(external_items\.canonical_url, EXCLUDED\.canonical_url\)/,
    );
  });

  it("still keys dedup on the identity, not the permalink", async () => {
    const client = mockClient();
    await insertActivityPubItem(client as never, SOURCE, item());
    // Keying the conflict on the human url would fork the dedup and mint a
    // second post_id for a status already ingested.
    expect(insertSql().sql).toMatch(
      /ON CONFLICT \(protocol, source_item_uri\)/,
    );
  });
});
