import type { PoolClient } from "pg";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { signEvent } from "./key-custody-client.js";
import {
  buildProfileEvent,
  buildFollowListEvent,
  buildRelayListEvent,
  discoveryEnabled,
  discoveryRelayTargets,
  type ProfileFields,
  type RelayListFields,
} from "./nostr-events.js";

// =============================================================================
// Discovery publishers (NOSTR-OUTBOUND-INTEROP-ADR §3)
//
// Each republish*() fetches the relevant state from the DB *at call time*,
// signs the corresponding replaceable event with the user's custodial key, and
// enqueues it into relay_outbox keyed on the account id (so a user's
// republishes serialise on the worker's per-(entity_type, entity_id) lock).
//
// Signing lives here in the gateway because key-custody is only reachable from
// the gateway; the feed-ingest worker can only publish pre-signed events. The
// kind-3 burst coalescing the ADR specified as a graphile job_key is therefore
// realised as a `follow_list_dirty` marker drained by the gateway scheduler
// sweep (runDiscoverySweep), which also doubles as backfill + self-heal.
//
// Two gates compose: the operator master switch DISCOVERY_PUBLISH_ENABLED=1
// (ships the feature dark) AND the per-user opt-in accounts.discovery_enabled
// (NETWORK-CONCIERGE-ADR §7). Both must be true before anything is published.
// retractFollowList is the exception — it cleans up on opt-OUT, so it is gated
// only by the master switch.
// =============================================================================

interface DiscoveryAccountRow extends ProfileFields, RelayListFields {
  id: string;
  status: string;
  discoveryEnabled: boolean;
  publishFollowGraph: boolean;
}

async function loadAccount(accountId: string): Promise<DiscoveryAccountRow | null> {
  const { rows } = await pool.query<{
    id: string;
    status: string;
    username: string | null;
    display_name: string | null;
    bio: string | null;
    avatar_blossom_url: string | null;
    hosting_type: string | null;
    self_hosted_relay_url: string | null;
    discovery_enabled: boolean;
    publish_follow_graph: boolean;
  }>(
    `SELECT id, status, username, display_name, bio, avatar_blossom_url,
            hosting_type, self_hosted_relay_url, discovery_enabled,
            publish_follow_graph
       FROM accounts WHERE id = $1`,
    [accountId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    status: r.status,
    username: r.username,
    displayName: r.display_name,
    bio: r.bio,
    avatarBlossomUrl: r.avatar_blossom_url,
    hostingType: r.hosting_type,
    selfHostedRelayUrl: r.self_hosted_relay_url,
    discoveryEnabled: r.discovery_enabled,
    publishFollowGraph: r.publish_follow_graph,
  };
}

// Current follow list as hex pubkeys: internal follows ∪ external nostr subs.
// Built from live state so a coalesced republish reflects the final set. A mute
// hides an external source from the feed but is not an unfollow, so muted subs
// stay in the list; only DELETE /feeds (unsubscribe) removes them.
export async function getFollowListPubkeys(accountId: string): Promise<string[]> {
  const [internal, external] = await Promise.all([
    pool.query<{ nostr_pubkey: string }>(
      `SELECT a.nostr_pubkey
         FROM follows f
         JOIN accounts a ON a.id = f.followee_id
        WHERE f.follower_id = $1 AND a.status = 'active'
          AND a.nostr_pubkey IS NOT NULL`,
      [accountId],
    ),
    pool.query<{ source_uri: string }>(
      `SELECT src.source_uri
         FROM external_subscriptions es
         JOIN external_sources src ON src.id = es.source_id
        WHERE es.subscriber_id = $1 AND src.protocol = 'nostr_external'`,
      [accountId],
    ),
  ]);

  const seen = new Set<string>();
  for (const r of internal.rows) {
    if (/^[0-9a-f]{64}$/i.test(r.nostr_pubkey)) seen.add(r.nostr_pubkey.toLowerCase());
  }
  for (const r of external.rows) {
    if (/^[0-9a-f]{64}$/i.test(r.source_uri)) seen.add(r.source_uri.toLowerCase());
  }
  return [...seen];
}

async function signAndEnqueue(
  accountId: string,
  entityType: "profile" | "follow_list" | "relay_list",
  template: Parameters<typeof signEvent>[1],
): Promise<void> {
  const signed = await signEvent(accountId, template, "account");
  await withTransaction(async (client) => {
    await enqueueRelayPublish(client, {
      entityType,
      entityId: accountId,
      signedEvent: signed as SignedNostrEvent,
      targetRelayUrls: discoveryRelayTargets(),
    });
  });
}

// ---------------------------------------------------------------------------
// kind 0 — profile
// ---------------------------------------------------------------------------
export async function republishProfile(accountId: string): Promise<void> {
  if (!discoveryEnabled()) return;
  const account = await loadAccount(accountId);
  if (!account || account.status !== "active") return;
  if (!account.discoveryEnabled) return;
  await signAndEnqueue(accountId, "profile", buildProfileEvent(account));
}

// ---------------------------------------------------------------------------
// kind 10002 — relay list
// ---------------------------------------------------------------------------
export async function republishRelayList(accountId: string): Promise<void> {
  if (!discoveryEnabled()) return;
  const account = await loadAccount(accountId);
  if (!account || account.status !== "active") return;
  if (!account.discoveryEnabled) return;
  await signAndEnqueue(accountId, "relay_list", buildRelayListEvent(account));
}

// ---------------------------------------------------------------------------
// kind 3 — follow list. No-op when the user has opted out of publishing their
// follow graph. `force` publishes even an empty list (used when toggling the
// setting off, to retract a previously-published list).
// ---------------------------------------------------------------------------
export async function republishFollowList(
  accountId: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<void> {
  if (!discoveryEnabled()) return;
  const account = await loadAccount(accountId);
  if (!account || account.status !== "active") return;
  if (!account.discoveryEnabled) return;
  if (!account.publishFollowGraph) return;
  const pubkeys = await getFollowListPubkeys(accountId);
  if (pubkeys.length === 0 && !opts.allowEmpty) return;
  await signAndEnqueue(accountId, "follow_list", buildFollowListEvent(pubkeys));
}

// Retract a previously-published follow list by publishing an empty kind 3.
// Called when a user turns the publish_follow_graph setting off; bypasses the
// opt-out guard above precisely because the account is now opted out.
export async function retractFollowList(accountId: string): Promise<void> {
  if (!discoveryEnabled()) return;
  const account = await loadAccount(accountId);
  if (!account || account.status !== "active") return;
  await signAndEnqueue(accountId, "follow_list", buildFollowListEvent([]));
}

// ---------------------------------------------------------------------------
// Coalescing marker — set by follow/unfollow + external nostr sub/unsub. The
// scheduler sweep rebuilds the kind 3 once per cycle and clears the flag, so a
// burst of N actions collapses to one signed event. Marked only for opted-in
// accounts (the sweep would skip opted-out rows anyway). Best-effort: a missed
// mark still converges via the periodic self-heal pass.
// ---------------------------------------------------------------------------
export async function markFollowListDirty(
  accountId: string,
  exec: Pick<PoolClient, "query"> = pool,
): Promise<void> {
  await exec.query(
    `UPDATE accounts SET follow_list_dirty = TRUE
       WHERE id = $1 AND status = 'active'
         AND discovery_enabled = TRUE AND publish_follow_graph = TRUE`,
    [accountId],
  );
}

// =============================================================================
// Scheduler sweep — coalesce dirty follow lists + backfill/self-heal.
// Invoked once per gateway scheduler cycle (advisory-locked, single-instance).
// =============================================================================

const DIRTY_BATCH = 200; // follow-list republishes per cycle
const HEAL_BATCH = 25; // full (kind 0/3/10002) backfill/self-heal accounts per cycle
const HEAL_INTERVAL = "7 days"; // re-publish each account's discovery events at least this often

export async function runDiscoverySweep(): Promise<void> {
  if (!discoveryEnabled()) return;

  // Phase A — drain coalesced follow-list republishes.
  const { rows: dirty } = await pool.query<{ id: string }>(
    `SELECT id FROM accounts
       WHERE follow_list_dirty AND status = 'active' AND discovery_enabled
       ORDER BY id
       LIMIT $1`,
    [DIRTY_BATCH],
  );
  for (const { id } of dirty) {
    // Claim before read (D5): clear the dirty flag *before* republishFollowList
    // reads the follow set. A follow/unfollow landing during the republish
    // re-marks the row (markFollowListDirty), so the next cycle re-publishes
    // with the new set — whereas clearing *after* the read would clobber that
    // mark and strand the update until the 7-day self-heal. On failure we
    // restore the flag so the work isn't dropped.
    await pool.query(`UPDATE accounts SET follow_list_dirty = FALSE WHERE id = $1`, [id]);
    try {
      // allowEmpty: an unfollow-to-zero is a legitimate state to publish.
      await republishFollowList(id, { allowEmpty: true });
    } catch (err) {
      logger.warn({ err, accountId: id }, "discovery sweep: follow-list republish failed");
      await pool
        .query(
          `UPDATE accounts SET follow_list_dirty = TRUE
             WHERE id = $1 AND status = 'active'
               AND discovery_enabled = TRUE AND publish_follow_graph = TRUE`,
          [id],
        )
        .catch((e) =>
          logger.warn({ err: e, accountId: id }, "discovery sweep: failed to restore dirty flag"),
        );
      continue; // restored dirty (when still opted-in) so a later cycle retries
    }
  }
  // Clear any dirty flags on opted-out accounts (discovery off, or follow-graph
  // opt-out within a discovery-on account) so they don't spin the sweep.
  await pool.query(
    `UPDATE accounts SET follow_list_dirty = FALSE
       WHERE follow_list_dirty
         AND (discovery_enabled = FALSE OR publish_follow_graph = FALSE)`,
  );

  // Phase B — backfill + self-heal: least-recently-synced opted-in accounts.
  const { rows: heal } = await pool.query<{ id: string }>(
    `SELECT id FROM accounts
       WHERE status = 'active' AND discovery_enabled AND nostr_pubkey IS NOT NULL
         AND (discovery_synced_at IS NULL
              OR discovery_synced_at < now() - ($2)::interval)
       ORDER BY discovery_synced_at NULLS FIRST
       LIMIT $1`,
    [HEAL_BATCH, HEAL_INTERVAL],
  );
  for (const { id } of heal) {
    try {
      await republishProfile(id);
      await republishRelayList(id);
      await republishFollowList(id); // skips when opted out or empty
    } catch (err) {
      logger.warn({ err, accountId: id }, "discovery sweep: heal republish failed");
      continue; // don't stamp synced_at — retry next cycle
    }
    await pool.query(`UPDATE accounts SET discovery_synced_at = now() WHERE id = $1`, [id]);
  }

  if (dirty.length > 0 || heal.length > 0) {
    logger.info(
      { dirty: dirty.length, healed: heal.length },
      "discovery sweep complete",
    );
  }
}
