// =============================================================================
// Slice 8 P1 — cross-source dedup SQL fragments.
//
// Factored out of feeds/items.ts so the integration test (gateway/tests/
// dedup-integration.test.ts) exercises the *exact same* SQL the live feed query
// runs — there is no second copy to drift. The host query is responsible for the
// `source_pool` CTE (the feed's DELIVERABLE candidate item set, projecting
// `fi_id` + `allow_replies`), a pass whose WHERE takes dedupSuppressFilter(),
// and a final page relation aliased `scored` projecting `fi_id` (which the
// provenance lateral keys on); the fragments below slot in between and after.
//
// `source_pool` must be taken BEFORE any sampling the host does. The live feed
// cuts each source down to a `throughput` fraction whose membership shifts from
// page to page, and a winner drawn from the post-cut set is a winner that
// changes with the page — the one thing this design exists to rule out. See
// lib/source-selection.ts › WHY DEDUP SITS IN THE MIDDLE.
//
// Param contract: `$1` is the reader id (already threaded through
// sourceFilteredItems); the confidence floor's param INDEX is an argument,
// because the host's layout varies (the cursor pair and the blend's four are
// both optional) — same shape as feed-rank's `feedAlphaCte`. Owner-aware: a link applies when it is global
// (`owner_id IS NULL`, P3 automated detection) or asserted by this reader
// (`owner_id = $1`, P2 "Link to…"), minus any pair this reader has tombstoned
// (P3 `user_unlinked` negative override — see below).
//
// HOST REQUIREMENT: because `DEDUP_CTES` contains a recursive CTE (the link-graph
// transitive closure, `link_closure`), a host that splices it in MUST open with
// `WITH RECURSIVE` (Postgres puts the keyword once on the outer WITH; the
// non-recursive CTEs in the list are unaffected). The test and the EXPLAIN
// script always splice, so they are always `WITH RECURSIVE`; the live feed query
// splices conditionally and takes the keyword with it — see
// DEDUP_APPLICABLE_EXISTS_SQL at the foot of this file for why the keyword must
// go away with the block rather than being left in harmlessly.
// =============================================================================
import { getPlatformConfig } from "./platform-config.js";

// The dedup CTEs. Slot between `source_pool` and whatever consumes `suppressed`:
//   WITH RECURSIVE feed_alpha AS (…), source_arms AS (…), source_pool AS (…),
//                  ${DEDUP_CTES}, source_windowed AS (…), …
//
// Two cross-posted copies never sort adjacently — one copy can be on page 1 and
// its twin on page 3 — so in-page dedup leaks the twin. Instead we pick a winner
// per fingerprint that depends neither on the page nor on the sort key, and
// suppress the losers across the whole candidate set (`source_pool`, pre-cut and
// pre-LIMIT).
//
// WHAT THIS ACTUALLY MATCHES, because the header used to claim more (§6.5). The
// fingerprint (migration 123) prefers a canonical URL and falls back to a hash
// of the normalised text — and the URL arm has NEVER FIRED. Only
// feed-ingest/src/lib/email-ingest.ts writes `external_items.canonical_url`;
// rss, nostr, atproto and activitypub all leave it NULL, so 0 of 166,754 items
// on dev carry one and every fingerprint in the database is the text arm.
// Two consequences, both silent:
//
//   • The example this header used to lead with — "an article on RSS + its
//     Bluesky share" — CANNOT match and never could. The share's text is a
//     sentence and a link; the article's is the body. What actually dedups is
//     verbatim cross-posting of the same note to two networks, which is a
//     narrower and more useful thing than the header implied.
//   • A link-only post has no fingerprint at all: `external_items_norm_text`
//     strips URLs and the function returns NULL under 32 surviving characters,
//     so 44,895 items (27%) sit outside dedup entirely, averaging 12 characters
//     after normalisation.
//
// Reviving the URL arm is the only route to article-level dedup, and it is a
// feature rather than a repair: writing the column is the easy half, and a bare
// string equality over URLs matches almost nothing without a normaliser (utm
// params, trailing slashes, http/https, AMP, syndication wrappers). It also
// widens the blast radius in exactly the direction the confidence floor was
// added to narrow — "two people shared the same BBC story" becomes a collision —
// so it wants the floor's measurement behind it first, not before it.
//
// `applicable_links` materialises the links that apply to THIS reader once, and
// everything downstream references it: global (owner NULL) ∪ this reader's own
// assertions, EXCLUDING the `user_unlinked` negative override itself and any
// (ordered) pair the reader has tombstoned with one (P3 — a reader can't delete a
// global fact for everyone, so unlinking a detected link writes an owner-scoped
// tombstone the read path subtracts).
//
// TRANSITIVE connectivity (not pairwise): the same content cross-posted to three+
// sources may be linked as a CHAIN (s1–s2, s2–s3, no s1–s3) or a STAR (a native
// bridged to two mirrors that aren't linked to each other). A pairwise winner rule
// leaks here — if the connecting source is the loser it gets suppressed by both
// ends, leaving two same-fingerprint copies that aren't *directly* linked both
// surviving. So we compute the link graph's connected components once
// (`link_closure` → `source_component`) and dedup within a (component, fingerprint)
// group: one component → one survivor, however the edges are shaped.
//
// Perf guard: only sources in an applicable link get a component, so `candidates`
// inner-joins `source_component` and never sees an unlinked source. Most feeds have
// zero links → the closure and candidates are empty → near-zero cost. Components
// are tiny (a handful of cross-posted sources), so the transitive closure is cheap.
// ── The confidence floor (§6.1 + §6.3) ───────────────────────────────────────
//
// `external_identity_links.confidence` has been recorded since migration 123 and
// read by nothing: a 0.6 `domain_match` guessed by a cron hid content exactly as
// hard as a 1.0 link a reader asked for by hand. This is the dial that makes it
// mean something, and it is the whole of the answer to "domain_match auto-merges
// distinct people sharing a website" — the detector keeps running and keeps
// recording what it finds, because a 0.6 link is real EVIDENCE (it is what a
// future "are these the same person?" prompt would be built on); it just stops
// being an instruction to hide somebody's posts.
//
// Why a floor rather than a fix to the detector: the fingerprint cannot be made
// person-discriminating and never could be. Two people posting the same headline
// is ordinary — of the 82 fingerprint groups in dev that span more than one
// source, a hand read of the same population (§6.7) found 88 of 89 were
// different authors syndicating the same tech-news line, and one was a genuine
// cross-post. So the content key can only ever say "these two posts are the same
// text"; ALL of the identity claim rides on the link, and a weak link is
// therefore the only thing that can turn a normal coincidence into a reader
// silently losing a post. Tighten the link, not the text.
//
// Default 0.9: admits `bridge` (0.95 — a bridge mirror EMBEDS the original
// identity, so it is a decode, not a guess) and `user_asserted` (1.0 — the
// reader said so), excludes `domain_match` (0.6). Retuning is an UPDATE, per the
// tuning-dial rule, and lowering it to 0.5 is how an operator would switch
// domain-matching on after measuring it.
const DEDUP_MIN_CONFIDENCE_FALLBACK = 0.9;

/** The floor below which a recorded link does not suppress anything. */
export async function dedupMinConfidence(): Promise<number> {
  const cfg = await getPlatformConfig();
  const raw = cfg.get("dedup_min_confidence");
  // A BLANK row is absent, not zero. `Number("")` is 0, and 0 is a legal floor
  // here (an operator may genuinely want every recorded link to merge), so the
  // usual `Number.isFinite && > 0` shape would read an empty row as the most
  // permissive setting there is — a value nobody chose, in the direction that
  // hides content. The parity suite's junk case is what caught this.
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  // Junk, negative or >1 → the fallback. A NaN floor compares false against
  // every confidence, which would silently disable dedup entirely; a floor
  // above 1 would do the same deliberately-looking thing.
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEDUP_MIN_CONFIDENCE_FALLBACK;
}

export function dedupCtes(confParam: number): string {
  return `
    applicable_links AS (
      SELECT l.source_a_id, l.source_b_id
        FROM external_identity_links l
       WHERE (l.owner_id IS NULL OR l.owner_id = $1)
         AND l.link_type <> 'user_unlinked'
         AND l.confidence >= $${confParam}   -- the §6.3 floor; see dedupMinConfidence
         AND NOT EXISTS (
           SELECT 1 FROM external_identity_links t
            WHERE t.link_type = 'user_unlinked'
              AND t.owner_id = $1
              AND t.source_a_id = l.source_a_id
              AND t.source_b_id = l.source_b_id
         )
    ),
    linked_sources AS (
      SELECT source_a_id AS sid FROM applicable_links
      UNION
      SELECT source_b_id FROM applicable_links
    ),
    -- Symmetric edges over the applicable links, plus a reflexive self-edge per
    -- linked source so an isolated linked source is its own singleton component.
    link_edges AS (
      SELECT source_a_id AS u, source_b_id AS v FROM applicable_links
      UNION
      SELECT source_b_id AS u, source_a_id AS v FROM applicable_links
      UNION
      SELECT sid AS u, sid AS v FROM linked_sources
    ),
    -- Transitive closure of the link graph (UNION dedupes → terminates). Cheap:
    -- the graph is just the reader's applicable links, components are tiny.
    link_closure AS (
      SELECT u AS node, v AS reach FROM link_edges
      UNION
      SELECT c.node, e.v
        FROM link_closure c JOIN link_edges e ON e.u = c.reach
    ),
    -- Component id = MIN reachable source. Edges are symmetric, so every node in a
    -- component reaches the same set → the same min → a stable component key. Cast
    -- to text: there is no min(uuid) aggregate, and comp is only ever equality-
    -- compared (never ordered), so the text representative is purely an identifier.
    source_component AS (
      SELECT node AS sid, MIN(reach::text) AS comp
        FROM link_closure
       GROUP BY node
    ),
    candidates AS (
      SELECT m.fi_id, fi.source_id, fi.source_protocol, fi.published_at,
             ei.dedup_fingerprint AS fp, sc.comp,
             (CASE fi.biddability_tier
                WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END) AS tprio
        FROM source_pool m
        JOIN feed_items fi ON fi.id = m.fi_id
        JOIN external_items ei ON ei.id = fi.external_item_id   -- external only
        -- Linked sources only (the guard) + tag the component. Asked of every
        -- source that SERVES the item (CA-C4, external_item_sources), not only
        -- the one that wrote it first — a shared item reaches the feed through
        -- all of them. MIN picks one component deterministically where two
        -- unlinked components both serve it.
        JOIN LATERAL (
          SELECT MIN(sc.comp) AS comp
            FROM external_item_sources eis
            JOIN source_component sc ON sc.sid = eis.source_id
           WHERE eis.external_item_id = fi.external_item_id
        ) sc ON sc.comp IS NOT NULL
        WHERE ei.dedup_fingerprint IS NOT NULL
          -- M11 — A ROW THAT CANNOT RENDER MUST NOT BE THE WINNER, or it
          -- suppresses its visible sibling and is then filtered itself, hiding
          -- BOTH copies. So every predicate the host applies AFTER suppression
          -- is mirrored here. The fragment carries them itself rather than
          -- trusting the caller to have filtered: a host that hands over an
          -- unfiltered pool must still get a deliverable winner.
          --
          -- The first two are belt-and-braces against the live host, which
          -- since migration 202 applies both inside its selection arms (a
          -- context-only or reply row is not in source_pool at all). They stay
          -- because the test and EXPLAIN hosts build their own pool.
          AND ei.is_context_only IS NOT TRUE
          AND (fi.is_reply IS NOT TRUE OR m.allow_replies)
          -- Blocks and mutes are NOT mirrored anywhere else: the live host
          -- applies them in the ranking pass, downstream of suppression, and
          -- until this pair was added a blocked author's copy could win and
          -- take its visible twin down with it. Cheap here: candidates is
          -- already narrowed to fingerprinted items on linked sources.
          AND NOT EXISTS (
            SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = fi.author_id
          )
    ),
    -- A candidate loses when another candidate in the SAME component with the same
    -- fingerprint ranks ahead under the total order tprio (A→0…D→3) ASC,
    -- published_at ASC, (source_id, fi.id) ASC — a lexicographic row comparison.
    -- Exactly one row per (component, fingerprint) has nothing ahead of it.
    suppressed AS (
      SELECT c.fi_id
        FROM candidates c
       WHERE EXISTS (
         SELECT 1 FROM candidates d
          WHERE d.fp = c.fp
            AND d.comp = c.comp
            AND d.fi_id <> c.fi_id
            AND (d.tprio, d.published_at, d.source_id, d.fi_id)
              < (c.tprio, c.published_at, c.source_id, c.fi_id)
       )
    )`;
}

// Drop the loser of a cross-source duplicate pair.
//
// Takes the host's spelling of the item id because the two hosts spell it
// differently and one spelling in one place is the point: the live feed applies
// it inside `source_windowed`, where the column is a bare `fi_id`, while the
// test/EXPLAIN hosts apply it in a pass that has `feed_items` joined as `fi`.
export function dedupSuppressFilter(idExpr: string): string {
  return `AND ${idExpr} NOT IN (SELECT fi_id FROM suppressed)`;
}

// Provenance ("ALSO ON BLUESKY · MASTODON"): computed only for survivors (a
// handful of post-filter rows) — the other component members carrying the same
// fingerprint. Keyed on the survivor's own `candidates` row (`self`, matched by
// fi_id), so the host `scored` CTE need only project `fi_id` — no `comp`/`fp` to
// thread through. Empty/NULL when the survivor isn't a linked-source candidate, so
// unlinked feeds are untouched. `::text` so node-pg returns a real string[] (a
// custom-enum array arrives unparsed as a raw "{atproto,rss}" string and breaks
// the UI .map).
export const DEDUP_PROVENANCE_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT d.source_protocol::text) AS also_on
      FROM candidates self
      JOIN candidates d
        ON d.comp = self.comp AND d.fp = self.fp AND d.fi_id <> self.fi_id
      WHERE self.fi_id = scored.fi_id
    ) prov ON true`;

// =============================================================================
// §6.6 — the applicability probe. Run this BEFORE building the feed query and
// splice the fragments above in only when it answers true.
//
// WHY A SEPARATE ROUND TRIP RATHER THAN LETTING THE CTEs SHORT-CIRCUIT: they
// already do, and that was never the cost. `candidates` returns 0 rows in
// 0.081 ms with no links — but `WITH RECURSIVE` is PARALLEL-UNSAFE in Postgres,
// so merely *containing* `link_closure` de-parallelises the entire feed query,
// including every node that has nothing to do with identity links. Measured on
// dev (2026-08-27, median of 7): a 717-source feed goes 129 ms → 232 ms and its
// plan goes `Gather Merge` (2 workers) → serial; forcing the baseline serial
// recovers ~75 of the ~90 ms, i.e. the whole gap. The tax is levied on the
// nodes AROUND the dedup block, which is why the 2026-07-25 in-situ EXPLAIN
// read as clean: it costed the dedup nodes, and those are genuinely free.
//
// THE PREDICATE IS DELIBERATELY WIDER THAN `applicable_links`: it omits that
// CTE's `user_unlinked` tombstone NOT EXISTS. So it can only ever
// OVER-approximate — say true when every applicable link is tombstoned, costing
// one reader one useless (correct) dedup pass — and can never say false while a
// link still applies, which would silently switch content suppression off for a
// reader who asked for it. Over-approximating is the safe direction and the
// test pins it that way; if you tighten this, tighten `applicable_links` first.
//
// The `link_type <> 'user_unlinked'` arm is NOT slack: a tombstone is a
// negative override that suppresses nothing on its own, so a reader holding
// only tombstones has no dedup to run.
//
// Param contract: `$1` is the reader id, same as DEDUP_CTES. This is a bare
// boolean EXPRESSION, not a statement, so the caller can fold it into a probe
// that reads other plan-shaping facts in the same round trip — there is one
// copy of the predicate and both the route and the test run it.
export function dedupApplicableExistsSql(confParam: number): string {
  return `
  EXISTS (
    SELECT 1 FROM external_identity_links
     WHERE (owner_id IS NULL OR owner_id = $1)
       AND link_type <> 'user_unlinked'
       AND confidence >= $${confParam}
  )`;
}
