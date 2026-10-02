import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// A REFUSAL WE CANNOT GET PAST IS RECORDED, AND EVERY OTHER FAILURE CLEARS IT
//
// The state migration 231 adds is real and was invisible: a source refused for
// want of a signature its instance will accept stays `is_active`, stays on
// schedule, and delivers nothing for ever. That is indistinguishable from an
// author who has stopped posting, and it is exactly how 381 dead sources went
// three months unnoticed. `signed_fetch_refused_at` is what makes it
// countable — so what has to be right is WHEN it is written and when it is
// cleared, not what Postgres does with the CASE.
//
// TWO KINDS OF ASSERTION, and the split is deliberate. Which UPDATE ran and
// what parameters it carried is DERIVABLE from the SQL and the args, and is
// asserted behaviourally. The `CASE WHEN … COALESCE(signed_fetch_refused_at,
// now()) END` is Postgres's to evaluate, so the case that reads it is a
// STRUCTURAL PIN on the statement — it proves the query still asks to keep the
// original date, never that it does.
//
// MUTATION CHECKS (each fails the named case):
//   stamp on every failure, not just a refusal  → "a 404 clears the stamp"
//   drop the NULL from the success UPDATE       → "a successful read clears it"
//   pass `deactivate` where `unsignable` goes   → "a refusal stamps and does not deactivate"
// =============================================================================

interface Call {
  sql: string;
  params: unknown[];
}
const calls: Call[] = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT id, source_uri")) {
        return {
          rows: [
            {
              id: "src-1",
              source_uri: "https://akkoma.example/users/alice",
              cursor: null,
              error_count: 3,
              display_name: null,
              avatar_url: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/lib/platform-blocks.js", () => ({
  isSourceBlocked: vi.fn(async () => false),
}));

vi.mock("../lib/activitypub-ingest.js", () => ({
  insertActivityPubItem: vi.fn(async () => false),
  recordInstanceSuccess: vi.fn(async () => undefined),
  recordInstanceFailure: vi.fn(async () => undefined),
}));

vi.mock("../lib/repost-edge.js", () => ({
  recordRepostEdge: vi.fn(async () => undefined),
}));

vi.mock("../lib/platform-config.js", () => ({
  getPlatformConfig: vi.fn(async () => new Map<string, string>()),
}));

const { ApFetchStatusError } = await import("../adapters/activitypub.js");
const mockFetchActor = vi.fn();
const mockFetchOutbox = vi.fn();
const mockFetchTimeline = vi.fn();

vi.mock("../adapters/activitypub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters/activitypub.js")>();
  return {
    ...actual,
    fetchActor: (...a: unknown[]) => mockFetchActor(...a),
    fetchOutbox: (...a: unknown[]) => mockFetchOutbox(...a),
    fetchMastodonTimeline: (...a: unknown[]) => mockFetchTimeline(...a),
  };
});

const { feedIngestActivityPub } = await import("./feed-ingest-activitypub.js");

const helpers = { addJob: vi.fn(async () => undefined) } as never;

/** The UPDATE the task issued against external_sources. */
function sourceUpdate(): Call {
  const hit = calls.find(
    (c) => c.sql.includes("UPDATE external_sources") && c.sql.includes("last_fetched_at"),
  );
  if (!hit) throw new Error("no external_sources UPDATE was issued");
  return hit;
}

beforeEach(() => {
  calls.length = 0;
  mockFetchActor.mockReset();
  mockFetchOutbox.mockReset();
  mockFetchTimeline.mockReset();
});

async function run() {
  await feedIngestActivityPub({ sourceId: "src-1" }, helpers);
}

describe("when a signed read is still refused", () => {
  beforeEach(() => {
    mockFetchActor.mockRejectedValue(
      new ApFetchStatusError("Actor fetch returned HTTP 401", 401),
    );
  });

  it("a refusal stamps and does not deactivate", async () => {
    await run();
    const { sql, params } = sourceUpdate();
    // The stamp flag is the LAST parameter and it is `unsignable`, which is a
    // different question from `deactivate` — they are both booleans on the same
    // statement, so a transposition typechecks and silently turns every refusal
    // into a deactivation.
    expect(params[5]).toBe(true);
    // …and the deactivate flag stays false: a capability WE lack must never
    // spend the source's life. This is the invariant migration 228 had to
    // repair 381 rows for.
    expect(params[3]).toBe(false);
    expect(sql).toContain("signed_fetch_refused_at");
  });

  it("STRUCTURAL PIN: the stamp keeps the date the run of refusals began", async () => {
    // COALESCE is Postgres's to evaluate. What is checkable here is that the
    // statement still asks for it — without it every poll rewrites the date and
    // "how long have we been locked out" silently becomes "six hours".
    await run();
    expect(sourceUpdate().sql).toMatch(
      /COALESCE\(signed_fetch_refused_at,\s*now\(\)\)/,
    );
  });
});

describe("when the failure is a fact about the source", () => {
  it("a 404 clears the stamp", async () => {
    // A source that has started 404ing is no longer one we are locked out of,
    // and leaving the stamp would go on inflating the count with rows whose
    // fault is somewhere else entirely.
    mockFetchActor.mockRejectedValue(
      new ApFetchStatusError("Actor fetch returned HTTP 404", 404),
    );
    await run();
    expect(sourceUpdate().params[5]).toBe(false);
  });

  it("a malformed document clears it too", async () => {
    mockFetchActor.mockRejectedValue(new Error("Actor has no outbox URL"));
    await run();
    expect(sourceUpdate().params[5]).toBe(false);
  });
});

describe("when the read succeeds", () => {
  it("a successful read clears it", async () => {
    mockFetchActor.mockResolvedValue({
      reader: "outbox",
      apiAccountId: null,
      id: "https://akkoma.example/users/alice",
      name: "Alice",
      preferredUsername: "alice",
      summary: null,
      icon: null,
      outbox: "https://akkoma.example/users/alice/outbox",
      url: null,
      host: "akkoma.example",
    });
    mockFetchOutbox.mockResolvedValue({ items: [], reposts: [], newCursor: null });

    await run();
    const { sql } = sourceUpdate();
    // We just read it, so whatever we could not read it for is over. Asserted
    // on the statement because this arm has no boolean to carry it — the
    // success UPDATE sets the column to NULL unconditionally, and a `SET`
    // list that stopped naming the column would leave a healed source counted
    // as unreadable for ever.
    expect(sql).toMatch(/signed_fetch_refused_at\s*=\s*NULL/);
    expect(sql).toContain("error_count     = 0");
  });
});
