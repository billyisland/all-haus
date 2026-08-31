import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// Waitlist operator digest (CLOSED-BETA-ADR §XI, D8.2).
//
// The contract under test — each case is one thing that, if it broke, would
// reproduce the failure this worker exists to fix (a prospect sitting unseen):
//
//   · it sends when the list has moved, to the ADMIN accounts' addresses, and
//     the body names every new joiner (and nothing else about them — the
//     publish-interest breakdown went with the question, 2026-07-27);
//   · the watermark advances to the NEWEST REPORTED ROW's created_at, never to
//     now() — a row arriving mid-run must be in the next digest, not lost;
//   · nothing new → no send AND no watermark write (the window stays open);
//   · COLD START opens the window at EPOCH, not now − interval: a clock-shaped
//     first window silently orphans any join older than the interval, forever
//     (it happened — the 2026-07-27 rows were never reported, because the
//     deploy landed a day later). It also made four of these tests wall-clock
//     dependent: they rotted red 24h after their fixtures were written;
//   · not yet due → no send, and no read of the waitlist at all;
//   · a send failure → NO watermark write, so the next run retries the same
//     rows (D7: the row is the product, the mail is the courtesy);
//   · the watermark is written by UPSERT, never a bare UPDATE, which against
//     an absent key matches zero rows and reports success;
//   · no admin ids, or admins with no email → no send, and no watermark write.
// =============================================================================

interface Q {
  sql: string;
  params: unknown[];
}

let queries: Q[] = [];
let waitlistRows: Array<{
  email: string;
  created_at: Date;
  /** Postgres renders microseconds; a JS Date cannot hold them. The mock keeps
   *  the extra digits so the truncation bug is REPRESENTABLE here. */
  created_at_exact: string;
}> = [];
let configRows: Array<{ key: string; value: string }> = [];
let adminIds: string[] = [];
let adminEmails: string[] = [];
let sent: Array<{ to: string; subject: string; textBody: string }> = [];
let failSend = false;

function query(sql: string, params: unknown[] = []) {
  queries.push({ sql, params });
  if (sql.includes("FROM platform_config")) {
    return Promise.resolve({ rows: configRows, rowCount: configRows.length });
  }
  if (sql.includes("FROM waitlist") && sql.includes("count(*)")) {
    return Promise.resolve({
      rows: [{ total: String(waitlistRows.length) }],
      rowCount: 1,
    });
  }
  if (sql.includes("FROM waitlist")) {
    // Compare as Postgres would: on the exact text, not the truncated Date.
    const since = String(params[0]);
    const rows = waitlistRows
      .filter((r) => r.created_at_exact > since)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (sql.includes("FROM accounts")) {
    return Promise.resolve({
      rows: adminEmails.map((email) => ({ email })),
      rowCount: adminEmails.length,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendEmail: (p: { to: string; subject: string; textBody: string }) => {
    if (failSend) return Promise.reject(new Error("postmark down"));
    sent.push(p);
    return Promise.resolve();
  },
}));

vi.mock("../src/middleware/admin.js", () => ({
  getAdminIds: () => Promise.resolve(adminIds),
}));

import { sendWaitlistDigest } from "../src/workers/waitlist-digest.js";

// Each pair is one instant: the Date the driver hands back, and the text
// Postgres renders — with a MICROSECOND component a Date cannot represent.
const OLD_EXACT = "2026-07-27T08:47:00.123456Z";
const MID_EXACT = "2026-07-27T08:55:00.500789Z";
const NEW_EXACT = "2026-07-27T16:13:00.808116Z";
const OLD = new Date(OLD_EXACT);
const MID = new Date(MID_EXACT);
const NEW = new Date(NEW_EXACT);

function markerWrites() {
  return queries.filter((q) => q.sql.includes("INTO platform_config"));
}

beforeEach(() => {
  queries = [];
  sent = [];
  failSend = false;
  adminIds = ["11111111-1111-1111-1111-111111111111"];
  adminEmails = ["owner@all.haus"];
  configRows = [];
  waitlistRows = [
    { email: "one@example.com", created_at: OLD, created_at_exact: OLD_EXACT },
    { email: "two@example.com", created_at: MID, created_at_exact: MID_EXACT },
    { email: "three@example.com", created_at: NEW, created_at_exact: NEW_EXACT },
  ];
});

describe("waitlist operator digest", () => {
  it("sends to the admin addresses and names every new joiner", async () => {
    const n = await sendWaitlistDigest();

    expect(n).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@all.haus");
    expect(sent[0].subject).toContain("3 new");
    for (const r of waitlistRows) {
      expect(sent[0].textBody).toContain(r.email);
    }
    // ...and the running total, which is how "the list is growing" reads.
    expect(sent[0].textBody).toContain("3 in total");
    // AND NOTHING ABOUT WHAT THEY WANT. The digest used to break the total down
    // by who had ticked "I'd also like to publish"; the question is gone from
    // the page and the reporting went with it. This pins the absence, so
    // reinstating either half fails here.
    expect(sent[0].textBody).not.toMatch(/publish/i);
    expect(queries.some((q) => q.sql.includes("publish_interest"))).toBe(false);
  });

  it("advances the watermark to the newest reported row, not to now()", async () => {
    await sendWaitlistDigest();

    const writes = markerWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].params[0]).toBe("waitlist_digest_watermark");
    // Exactly the newest row's timestamp. If this were now(), a row inserted
    // between the SELECT and this write would never appear in any digest.
    expect(writes[0].params[1]).toBe(NEW_EXACT);
    // Not the millisecond-truncated Date: that lands up to 999µs BEFORE the row
    // it came from, so the row re-qualifies and every digest re-reports its own
    // newest joiner. Found on a real database, not here — hence this line.
    expect(writes[0].params[1]).not.toBe(NEW.toISOString());
    // ...and the cadence clock is a SEPARATE key holding a clock reading.
    expect(writes[0].params[2]).toBe("waitlist_digest_last_sent_at");
    expect(writes[0].params[3]).not.toBe(NEW_EXACT);
  });

  it("writes the watermark by upsert, never a bare UPDATE", async () => {
    await sendWaitlistDigest();

    const sql = markerWrites()[0].sql;
    expect(sql).toContain("INSERT INTO platform_config");
    expect(sql).toContain("ON CONFLICT (key) DO UPDATE");
    // A bare UPDATE against an absent key matches zero rows and reports
    // success — the way jetstream_healthy silently never persisted.
    expect(sql.trimStart().startsWith("UPDATE")).toBe(false);
  });

  it("cold start reports joins OLDER than the interval — the window opens at epoch", async () => {
    // The regression that shipped: no watermark + a now−24h first window meant
    // any join more than a day old at first-run time was never reported and
    // never watermarked — unreported forever. Pin the clock far past every
    // fixture so this fails against a clock-relative window no matter when it
    // runs (the old shape passed or failed depending on the day of the week).
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));

    const n = await sendWaitlistDigest();

    expect(n).toBe(3);
    expect(sent[0].textBody).toContain("one@example.com");
    // ...and the watermark lands, so the whole-table digest happens ONCE.
    expect(markerWrites()[0].params[1]).toBe(NEW_EXACT);
    vi.useRealTimers();
  });

  it("reports only rows newer than the watermark", async () => {
    configRows = [
      { key: "waitlist_digest_watermark", value: OLD_EXACT },
      { key: "waitlist_digest_last_sent_at", value: OLD.toISOString() },
    ];
    // Far enough back that the interval has elapsed.
    vi.setSystemTime(new Date("2026-07-29T00:00:00Z"));

    const n = await sendWaitlistDigest();

    expect(n).toBe(2);
    expect(sent[0].textBody).not.toContain("one@example.com");
    expect(sent[0].textBody).toContain("two@example.com");
    expect(sent[0].textBody).toContain("three@example.com");
    vi.useRealTimers();
  });

  it("sends nothing and moves nothing when no one has joined", async () => {
    configRows = [
      { key: "waitlist_digest_watermark", value: NEW_EXACT },
      { key: "waitlist_digest_last_sent_at", value: NEW.toISOString() },
    ];
    vi.setSystemTime(new Date("2026-07-29T00:00:00Z"));

    const n = await sendWaitlistDigest();

    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
    // The watermark must NOT advance on an empty digest: the window stays open
    // so a join can never fall between two of them.
    expect(markerWrites()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("does not send twice inside the interval, and does not even look", async () => {
    configRows = [
      { key: "waitlist_digest_watermark", value: OLD_EXACT },
      { key: "waitlist_digest_last_sent_at", value: OLD.toISOString() },
    ];
    vi.setSystemTime(new Date(OLD.getTime() + 3600_000)); // 1h later, interval 24h

    const n = await sendWaitlistDigest();

    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
    expect(queries.some((q) => q.sql.includes("FROM waitlist"))).toBe(false);
    vi.useRealTimers();
  });

  it("keeps the comparison in Postgres's own precision", async () => {
    // A STRUCTURAL pin, and honestly weaker than the rest of this file: the
    // mock compares strings, so it cannot tell whether the cast is there.
    // Dropping either half only misbehaves against a real database — which is
    // exactly how the microsecond bug got in — so the shape is pinned here and
    // the behaviour is proven by driving it (FIX-PROGRAMME 2026-07-27).
    await sendWaitlistDigest();

    const read = queries.find(
      (q) => q.sql.includes("FROM waitlist") && !q.sql.includes("count(*)"),
    )!;
    expect(read.sql).toContain("created_at::text AS created_at_exact");
    expect(read.sql).toContain("$1::timestamptz");
  });

  it("does not re-report the row its own watermark came from", async () => {
    // The microsecond bug, pinned. The watermark is the newest row's exact
    // Postgres text; that row must not qualify again on the next run.
    configRows = [
      { key: "waitlist_digest_watermark", value: NEW_EXACT },
      { key: "waitlist_digest_last_sent_at", value: OLD.toISOString() },
    ];
    vi.setSystemTime(new Date("2026-07-29T00:00:00Z"));

    expect(await sendWaitlistDigest()).toBe(0);
    expect(sent).toHaveLength(0);
    vi.useRealTimers();
  });

  it("asks the CLOCK whether it is due, not the watermark", async () => {
    // The bug a real run caught and the unit tests missed: one key serving as
    // both window and cadence. Here a digest went out an hour ago, but its
    // newest row was three days old (a quiet list). Read the watermark as the
    // cadence and this fires again immediately; read the clock and it waits.
    const threeDaysAgo = new Date(NEW.getTime() - 3 * 24 * 3600_000);
    configRows = [
      { key: "waitlist_digest_watermark", value: threeDaysAgo.toISOString() },
      { key: "waitlist_digest_last_sent_at", value: NEW.toISOString() },
    ];
    vi.setSystemTime(new Date(NEW.getTime() + 3600_000)); // 1h after the send

    expect(await sendWaitlistDigest()).toBe(0);
    expect(sent).toHaveLength(0);
    vi.useRealTimers();
  });

  it("honours the cadence dial", async () => {
    configRows = [
      { key: "waitlist_digest_watermark", value: OLD_EXACT },
      { key: "waitlist_digest_last_sent_at", value: OLD.toISOString() },
      { key: "waitlist_digest_interval_hours", value: "1" },
    ];
    vi.setSystemTime(new Date(OLD.getTime() + 2 * 3600_000)); // 2h later

    // Due under a 1h cadence where it would not be under the 24h default.
    expect(await sendWaitlistDigest()).toBe(2);
    vi.useRealTimers();
  });

  it("leaves the watermark alone when the send fails, so the next run retries", async () => {
    failSend = true;

    const n = await sendWaitlistDigest();

    expect(n).toBe(0);
    expect(markerWrites()).toHaveLength(0);

    // The retry proves the rows were not lost.
    failSend = false;
    expect(await sendWaitlistDigest()).toBe(3);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when there is no admin to tell", async () => {
    adminIds = [];

    expect(await sendWaitlistDigest()).toBe(0);
    expect(sent).toHaveLength(0);
    // Crucially the watermark does not move — otherwise configuring an admin
    // later would start the digest from a window that skipped everyone who
    // joined while it was unconfigured.
    expect(markerWrites()).toHaveLength(0);
  });

  it("sends nothing when the admin accounts have no email address", async () => {
    adminEmails = [];

    expect(await sendWaitlistDigest()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(markerWrites()).toHaveLength(0);
  });

  it("never throws, whatever the database does", async () => {
    configRows = [];
    const boom = vi
      .spyOn(await import("@platform-pub/shared/db/client.js"), "pool", "get")
      .mockReturnValue({
        query: () => Promise.reject(new Error("db down")),
      } as never);

    await expect(sendWaitlistDigest()).resolves.toBe(0);
    boom.mockRestore();
  });
});
