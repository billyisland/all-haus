// =============================================================================
// Slice 8 P1 — cross-source dedup SQL fragments.
//
// Factored out of feeds/items.ts so the integration test (gateway/tests/
// dedup-integration.test.ts) exercises the *exact same* SQL the live feed query
// runs — there is no second copy to drift. The host query is responsible for the
// `matched` CTE (the feed's pre-LIMIT candidate item set, projecting `fi_id` +
// `allow_replies`), a ranking pass whose WHERE takes DEDUP_SUPPRESS_FILTER, and
// a final page relation aliased `scored` projecting `fi_id` (which the
// provenance lateral keys on); the fragments below slot in between and after.
//
// Param contract: `$1` is the reader id (already threaded through
// sourceFilteredItems). Owner-aware: a link applies when it is global
// (`owner_id IS NULL`, P3 automated detection) or asserted by this reader
// (`owner_id = $1`, P2 "Link to…"), minus any pair this reader has tombstoned
// (P3 `user_unlinked` negative override — see below).
//
// HOST REQUIREMENT: because `DEDUP_CTES` contains a recursive CTE (the link-graph
// transitive closure, `link_closure`), the host's top-level `WITH` MUST be
// `WITH RECURSIVE` (Postgres puts the keyword once on the outer WITH; the
// non-recursive CTEs in the list are unaffected). Both call sites — feeds/items.ts
// and the integration test — open with `WITH RECURSIVE`.
// =============================================================================

// The dedup CTEs. Slot between `matched` and `scored`:
//   WITH RECURSIVE feed_mode AS (…), matched AS (…), ${DEDUP_CTES}, scored AS (…)
//
// Two cross-posted copies (e.g. an article on RSS + its Bluesky share) carry
// different effective_score, so they are not page-adjacent — in-page dedup leaks
// the twin. Instead we pick a page-independent winner per fingerprint and
// suppress losers across the whole candidate set (`matched`, pre-LIMIT).
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
export const DEDUP_CTES = `
    applicable_links AS (
      SELECT l.source_a_id, l.source_b_id
        FROM external_identity_links l
       WHERE (l.owner_id IS NULL OR l.owner_id = $1)
         AND l.link_type <> 'user_unlinked'
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
        FROM matched m
        JOIN feed_items fi ON fi.id = m.fi_id
        JOIN external_items ei ON ei.id = fi.external_item_id   -- external only
        JOIN source_component sc ON sc.sid = fi.source_id       -- linked sources only (the guard) + tag its component
        WHERE ei.dedup_fingerprint IS NOT NULL
          -- Mirror the host's post-suppression visibility predicates (items.ts
          -- scored WHERE) so a row that will be FILTERED can never be the dedup
          -- winner: otherwise a context-only or reply-suppressed twin could
          -- suppress its visible sibling and then be filtered itself, hiding BOTH
          -- copies (M11 — the exact SLICE-8 failure the candidate universe must
          -- prevent). These match the external-applicable filters at
          -- items.ts:281 (is_context_only) and :284 (is_reply / allow_replies).
          AND ei.is_context_only IS NOT TRUE
          AND (fi.is_reply IS NOT TRUE OR m.allow_replies)
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

// Drop the loser of a cross-source duplicate pair. Goes in the `scored` WHERE.
export const DEDUP_SUPPRESS_FILTER = `AND fi.id NOT IN (SELECT fi_id FROM suppressed)`;

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
