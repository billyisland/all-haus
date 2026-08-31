import { describe, it, expect } from "vitest";
import {
  externalFetchTask,
  externalFetchJobKey,
  externalFetchMaxAttempts,
} from "../src/routes/feeds/sources.js";

// =============================================================================
// EXTERNAL-AUTHOR-HISTORY-ADR §2.1/§2.2 — the subscribe-time enqueue mapping.
//
// nostr_external must map to the BACKFILL task under its own distinct job key:
// a fresh source (last_fetched_at IS NULL) is due on the very next 60s poll
// tick, and the poll scheduler enqueues under feed_ingest_<sourceId> — with a
// shared key, graphile-worker's job-key replacement would swap the still-queued
// backfill for a plain poll job, silently skipping the backfill almost every
// time. This test guards that collision from regressing.
// =============================================================================

const SOURCE_ID = "3f0a2b1c-0000-4000-8000-000000000001";

describe("externalFetchTask", () => {
  it("maps nostr_external to the backfill task", () => {
    expect(externalFetchTask("nostr_external")).toBe(
      "feed_ingest_nostr_backfill",
    );
  });

  it("keeps the other protocols' jobs unchanged", () => {
    expect(externalFetchTask("rss")).toBe("feed_ingest_rss");
    expect(externalFetchTask("activitypub")).toBe("feed_ingest_activitypub");
    expect(externalFetchTask("atproto")).toBe("feed_ingest_atproto_backfill");
    expect(externalFetchTask("email")).toBeNull();
  });
});

describe("externalFetchJobKey", () => {
  it("gives the nostr backfill its own key, distinct from the poll scheduler's", () => {
    expect(
      externalFetchJobKey("feed_ingest_nostr_backfill", SOURCE_ID),
    ).toBe(`feed_ingest_backfill_${SOURCE_ID}`);
  });

  it("keeps the shared poll key for every other task", () => {
    for (const task of [
      "feed_ingest_rss",
      "feed_ingest_activitypub",
      "feed_ingest_atproto_backfill",
    ]) {
      expect(externalFetchJobKey(task, SOURCE_ID)).toBe(
        `feed_ingest_${SOURCE_ID}`,
      );
    }
  });
});

describe("externalFetchMaxAttempts", () => {
  // Audit F2 (2026-07-09): atproto has no poll fallback while Jetstream is
  // healthy, so its backfill re-throws on failure and rides graphile-worker's
  // retry — it must get a real attempt budget. The poll-recovered protocols
  // stay at 1 (their retry IS the 60s poll scheduler).
  it("gives the atproto backfill retries and everything else one attempt", () => {
    expect(externalFetchMaxAttempts("feed_ingest_atproto_backfill")).toBe(5);
    for (const task of [
      "feed_ingest_rss",
      "feed_ingest_activitypub",
      "feed_ingest_nostr_backfill",
    ]) {
      expect(externalFetchMaxAttempts(task)).toBe(1);
    }
  });
});
