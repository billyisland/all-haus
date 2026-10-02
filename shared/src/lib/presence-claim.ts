// =============================================================================
// THE MEMBER'S ACTIVITY ELSEWHERE IS THEIRS (CROSS-NETWORK-ROUNDTRIP-ADR rung D).
//
// A linked presence proves an identity on another network. Migration 237's
// trigger (`network_presences_claim`) records that as
// `external_authors.account_id`, whatever writes the presence. This module is
// the one spelling of the three questions every reader of that claim asks, so
// the gateway (byline, profile log, reports, export) and feed-ingest (the
// member's own-post source, the GC) cannot drift apart.
//
// THE CLAIM IS NOT A DISCLOSURE. Telling a reader which all.haus member a
// Bluesky or Mastodon post belongs to publicly links two identities, so it
// answers to the presence's DISPLAY consent, `show_on_profile` (D-Q1, operator
// 2026-09-27) — the consent the profile's identity row and rung B's echo
// substitution already answer to, never the posting consent. With it off the
// claim is stored and used for what is the member's own business (their own
// profile log, their export), and no other reader learns it.
// =============================================================================

/**
 * SQL: the claiming member's account id where the claim is DISCLOSED, else
 * NULL. `xa` is an `external_authors` alias.
 *
 * The presence is matched on the full key, not on account + protocol alone:
 * the trigger keeps the pair in step, and the key is what makes a claim left
 * behind by some other path read as nobody's rather than somebody's.
 *
 * `a.status = 'active'`: a byline or report routed to a member whose profile
 * no longer answers is a link to nothing. Moderation asks
 * `claimantSql` instead, which does not filter on status.
 */
export function disclosedClaimantSql(xa: string): string {
  return `(SELECT np.account_id
             FROM network_presences np
             JOIN accounts a ON a.id = np.account_id
            WHERE np.account_id = ${xa}.account_id
              AND np.protocol = ${xa}.protocol
              AND np.stable_handle = ${xa}.stable_handle
              AND np.lifecycle_state = 'active'
              AND np.show_on_profile
              AND a.status = 'active')`;
}

/** SQL: that member's username, on the same terms as `disclosedClaimantSql`. */
export function disclosedClaimantUsernameSql(xa: string): string {
  return `(SELECT ua.username FROM accounts ua WHERE ua.id = ${disclosedClaimantSql(xa)})`;
}

/**
 * SQL: the claiming member's account id where the claim is DISCLOSED, whatever
 * the member's own status — the question moderation asks, because a report on
 * a suspended member's post is still about them.
 */
export function claimantSql(xa: string): string {
  return `(SELECT np.account_id
             FROM network_presences np
            WHERE np.account_id = ${xa}.account_id
              AND np.protocol = ${xa}.protocol
              AND np.stable_handle = ${xa}.stable_handle
              AND np.lifecycle_state = 'active'
              AND np.show_on_profile)`;
}

/**
 * SQL predicate: this `external_sources` row is a member's OWN presence (D2).
 * Such a source is ingested because the member linked it, not because it sits
 * in anybody's feed, so it carries no `external_subscriptions` row (that row is
 * a projection of feed membership, never a standalone record) and the GC must
 * spare it on that ground instead. `es` is an `external_sources` alias.
 */
export function presenceSourceSql(es: string): string {
  return `EXISTS (
            SELECT 1 FROM network_presences np
             WHERE np.protocol = ${es}.protocol
               AND np.stable_handle = ${es}.source_uri
               AND np.lifecycle_state = 'active')`;
}
