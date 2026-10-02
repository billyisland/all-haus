-- =============================================================================
-- config-defaults.sql — the canonical default value of every platform_config
-- tuning dial. Applied by shared/src/db/migrate.ts on EVERY run, after the
-- migration chain, always with ON CONFLICT (key) DO NOTHING.
--
-- WHY THIS FILE EXISTS
--
-- Dials used to be seeded by the migration that introduced them. That silently
-- did not work on a fresh database. schema.sql is the genesis base and is
-- STRUCTURE ONLY (pg_dump, no data) — but it also seeds `_migrations` with every
-- migration filename, so migrate.ts skips those migrations as already-applied
-- and their INSERTs never run. Any dial seeded by a migration older than the
-- current genesis dump was therefore simply absent on every DB booted from
-- schema.sql. Measured on dev 2026-07-20: 31 of 45 dials missing.
--
-- Mostly that was masked, because each consumer carries a code fallback equal to
-- the seeded value — but "masked" is not "harmless": it demotes an operator dial
-- to a code constant (an UPDATE on a missing row changes nothing and reports no
-- error), and it was NOT harmless for `jetstream_healthy`, whose writer is an
-- UPDATE that matched zero rows, so the Jetstream listener could never record
-- itself unhealthy and the atproto polling fallback never engaged.
--
-- THE RULE (CLAUDE.md, tuning-dial section)
--
--   A migration must NOT seed platform_config. New dials go HERE.
--
-- CI-enforced by scripts/check-schema-drift.sh Check 4, which allowlists exactly
-- the 11 historical migrations below (migrations are immutable, so that set is
-- closed forever) and rejects an INSERT INTO platform_config in any other one.
--
-- ON CONFLICT (key) DO NOTHING is load-bearing on every statement: this file is
-- re-applied on every migrate run, so it seeds a missing default and must NEVER
-- overwrite a value an operator has tuned.
--
-- NOT here, deliberately: runtime STATE that happens to live in this table.
-- `payouts_halted` means "halted" by its presence and is DELETEd to resume
-- (payment-service/src/lib/payout-halt.ts) — a seeded default would fight the
-- resume path. Absence is its meaning; only tuning dials belong in this file.
--
-- The blocks below are the historical seeds, verbatim from the migration that
-- introduced each, in chronological order.
-- =============================================================================

-- from 033_admin_account_ids_config.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('admin_account_ids', '', 'Comma-separated account UUIDs with admin access')
ON CONFLICT (key) DO NOTHING;

-- from 035_feed_scores.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_gravity',              '1.5', 'Time-decay exponent for feed scoring (HN-style)'),
  ('feed_weight_reaction',      '1',   'Score weight for reactions'),
  ('feed_weight_reply',         '2',   'Score weight for replies'),
  ('feed_weight_quote_comment', '3',   'Score weight for quote comments'),
  ('feed_weight_gate_pass',     '5',   'Score weight for gate passes (paid reads)')
ON CONFLICT (key) DO NOTHING;

-- from 038_publications.sql  -- ON CONFLICT added here: the original migration had none
--
-- Read by the publication payout cycle's eligibility query only (payout.ts,
-- runPublicationPayoutCycle). It had NO reader from migration 038 until
-- 2026-08-06 — that query bound writer_payout_threshold_pence, so an operator
-- edit here succeeded and changed nothing (CONSOLIDATED-TODO §1.14, the "dial
-- with no reader" class). It matches the writer threshold by default because
-- the two cycles are exact complements over disjoint revenue; they are separate
-- dials so a publication pool can be moved without moving every writer.
INSERT INTO platform_config (key, value, description) VALUES
  ('publication_payout_threshold_pence', '2000', 'Publication payout threshold (£20.00)')
ON CONFLICT (key) DO NOTHING;

-- from 052_universal_feed_external.sql  -- ON CONFLICT added here: the original migration had none
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_ingest_rss_interval_seconds',     '300',  'A new RSS source''s first polling interval (seconds); adaptive after that, between the min/max dials'),
  ('feed_ingest_rss_min_interval_seconds', '60',   'Minimum RSS polling interval'),
  ('feed_ingest_ap_interval_seconds',      '120',  'INERT — no reader. Superseded by feed_ingest_ap_default_interval, which ActivityPub polling reads'),
  ('feed_ingest_max_items_per_fetch',      '50',   'Max items to ingest per poll cycle'),
  ('feed_ingest_error_backoff_factor',     '2',    'Exponential backoff multiplier on fetch errors'),
  ('feed_ingest_max_error_count',          '10',   'Deactivate source after N consecutive errors'),
  ('feed_ingest_daily_cap_default',        '100',  'INERT — reserved, not enforced. The per-source daily item cap was never built (CA-F4)'),
  ('feed_ingest_max_per_host',             '2',    'Max concurrent fetch jobs per hostname'),
  ('feed_ingest_max_concurrent',           '10',   'Global max concurrent fetch jobs'),
  ('outbound_max_retries',                 '3',    'Max retry attempts for outbound cross-posts'),
  ('outbound_retry_delay_seconds',         '30',   'Base delay between outbound retries'),
  ('external_items_retention_days',        '90',   'Days to retain external items before pruning'),
  ('max_subscriptions_per_user',           '200',  'INERT — reserved, not enforced. The per-member source cap was never built (CA-F4)')
ON CONFLICT (key) DO NOTHING;

-- from 055_universal_feed_atproto.sql
-- jetstream_healthy is runtime STATE, seeded here deliberately (contrast
-- payouts_halted, whose ABSENCE means "not halted" and which must NOT be
-- seeded): its writer upserts, but a fresh DB must read healthy from first
-- boot — an absent row would schedule getAuthorFeed fallbacks for every
-- atproto source until the listener's first status write.
INSERT INTO platform_config (key, value, description) VALUES
  ('jetstream_healthy',                'true',
    'Set by the Jetstream listener. When false, feed_ingest_poll schedules getAuthorFeed fallback jobs for atproto sources.'),
  ('feed_ingest_atproto_backfill_hours', '24',
    'Lookback window for the one-time atproto backfill job when a new Bluesky source is subscribed to.'),
  ('feed_ingest_atproto_reconnect_max_seconds', '30',
    'Maximum exponential backoff delay (seconds) between Jetstream reconnection attempts.')
ON CONFLICT (key) DO NOTHING;

-- from 056_universal_feed_activitypub.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_ingest_ap_page_limit',           '20',
    'Max outbox pages to paginate per poll (stops early on a known cursor).'),
  ('feed_ingest_ap_items_per_page',       '20',
    'Desired items per outbox page request (instance may ignore).'),
  ('feed_ingest_ap_backfill_hours',       '24',
    'Lookback window for the initial outbox backfill on new subscription.'),
  ('feed_ingest_ap_default_interval',     '300',
    'Default per-source outbox polling interval (seconds).')
ON CONFLICT (key) DO NOTHING;

-- from 057_universal_feed_outbound.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('outbound_token_refresh_window_pct', '80',
    'Refresh OAuth tokens once elapsed lifetime exceeds this percent of expiry'),
  ('outbound_bluesky_max_graphemes',    '300',
    'Bluesky post graph­eme limit; replies longer are truncated with an all.haus link'),
  ('outbound_mastodon_max_chars',       '500',
    'Default Mastodon status length; replies longer are truncated with an all.haus link')
ON CONFLICT (key) DO NOTHING;

-- from 106_feed_ingest_enqueue_cap.sql
INSERT INTO platform_config (key, value, description)
VALUES (
  'feed_ingest_max_enqueue_per_tick',
  '100',
  'Max sources enqueued per poll tick (decoupled from runner concurrency; = source SELECT LIMIT)'
)
ON CONFLICT (key) DO NOTHING;

-- from 158_resonance_baselines.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('resonance_weight_like',           '1', 'Resonance E weight: external like/reaction/favourite'),
  ('resonance_weight_reply',          '3', 'Resonance E weight: reply (all protocols)'),
  ('resonance_weight_repost',         '2', 'Resonance E weight: external repost/boost'),
  ('resonance_weight_zap',            '4', 'Resonance E weight: nostr zap count (reserved; inert until zap ingestion)'),
  ('resonance_weight_native_up',      '5', 'Resonance E weight: native up-vote (free, capped one per voter/target/direction — see migration header)'),
  ('resonance_weight_native_gate',    '5', 'Resonance E weight: native gate pass (paid read)'),
  ('resonance_weight_native_repost',  '2', 'Resonance E weight: native repost (inert until native repost recording lands)'),
  ('resonance_shrink_k',              '3', 'Baseline shrinkage toward ambient: baseline=(n*median+k*p50)/(n+k)'),
  ('feed_alpha_following',            '0.8', 'D6 proof blend on following surfaces: alpha*resonance + (1-alpha)*ambient percentile'),
  ('feed_alpha_explore',              '0.4', 'D6 proof blend on explore surfaces')
ON CONFLICT (key) DO NOTHING;

-- from 160_resonance_band_thresholds.sql
--
-- RETUNED 2026-09-14 (operator: the marks read too sparse on a mixed feed),
-- 2.5/4/6 -> 1.8/3/5. Re-measured on the dev corpus of 134,177 scored rows
-- (90,521 atproto + 43,656 activitypub) simulating the band expression off the
-- stored `resonance` and `ambient_pctl` — the latter IS the veto, since
-- pctl >= 0.5 is exactly E >= p50 and pctl >= 0.9 exactly E >= p90:
--
--                 band>=1        band 3
--   old 2.5/4/6   16.7%          2.2%
--   new 1.8/3/5   24.8%          4.1%      (atproto 27.7 / 4.9,
--                                           activitypub 18.7 / 2.4)
--
-- Sparseness was never only the gate. A THIRD of the corpus can carry no mark
-- at all — nostr_external and rss produce no ambient row, so their rows stay
-- NULL by construction (absence, not zero) — so a quarter of SCORED rows is
-- about 15% of what a mixed feed actually shows. 1.5 was measured too (28.7%)
-- and refused: a mark on nearly a third of what can carry one stops being a
-- mark. Band 3 stays the confirmation it was designed as (ADR D2) at ~4%.
--
-- ON CONFLICT DO NOTHING, so this reaches FRESH databases only — every
-- existing DB still holds migration 160's values. Retuning a live one is the
-- operator act it was designed to be: set the three keys in the admin config
-- editor, then run `scripts/reband-resonance.sql`, because the band is STORED
-- and the scorer only ever revisits rows whose counts moved (that script's
-- header carries the reasoning).
INSERT INTO platform_config (key, value, description) VALUES
  ('resonance_band1_min', '1.8', 'Resonance gate for band 1 "noticed" (also requires E >= ambient p50)'),
  ('resonance_band2_min', '3',   'Resonance gate for band 2 "resonant" (also requires E >= ambient p50)'),
  ('resonance_band3_min', '5',   'Resonance gate for band 3 "surging" (also requires E >= ambient p90)')
ON CONFLICT (key) DO NOTHING;

-- from 161_feed_proof_floor.sql
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_proof_floor', '0.05', 'D6 read-time blend: floor under proof_term so zero-proof items still order by recency instead of collapsing to a constant (see migration header)')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Recovered from the ORIGINAL genesis seed (2026-07-20).
--
-- These six were never seeded by any migration because they predate the
-- migration chain: schema.sql itself carried an INSERT INTO platform_config,
-- and commit f8c73e6 ("chore(schema): regenerate schema.sql from current DB
-- state") silently dropped it — a --schema-only pg_dump carries no data. Since
-- that regeneration they have existed ONLY as code fallbacks on any DB built
-- from schema.sql, so the platform fee, the free allowance and both settlement
-- thresholds were operator-untunable: an UPDATE on a missing row changes
-- nothing and reports no error.
--
-- Values verified identical to both the pre-f8c73e6 seed AND today's code
-- fallbacks in shared/src/db/client.ts::loadConfig — this restores the dials
-- without changing any behaviour.
--
-- NOT recovered, deliberately: note_char_limit, comment_char_limit and
-- media_max_size_bytes were in that same seed but have no reader anywhere in
-- the repo (checked across all services and web). Dead config stays dead.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('free_allowance_pence',           '500',  'New reader free allowance (£5.00)'),
  -- The paywall-arrival cap, and it is DELIBERATELY NOT the allowance dial.
  -- The arrival grant is `free_allowance_pence + p`, so a piece priced at the
  -- full allowance doubles what a single signup is worth — and the gift is
  -- fungible, so the doubling is spendable anywhere. Allowance reads earn
  -- writers nothing, which puts the cost of that on writers rather than on the
  -- platform. Capping the ARRIVAL below the allowance bounds the amplification
  -- without touching the ordinary welcome (operator decision 2026-09-06,
  -- CONSOLIDATED-TODO §0v). Above this the piece stays gated and the reader
  -- presses the button — D4 Path C, which the modal already words.
  ('arrival_gift_cap_pence',         '200',  'Max article price the paywall-arrival gift will cover (£2.00); above this the piece stays gated'),
  ('tab_settlement_threshold_pence', '800',  'Reader tab threshold that triggers Stripe charge (£8.00)'),
  -- The cap on what a reader may OWE at one time (Reader Terms 4.4), read by
  -- the gate pass. Not the same question as the threshold above even though the
  -- text names one figure for both: the threshold decides when we charge, the
  -- cap decides when we stop selling. A settlement's charge does not reduce the
  -- balance until Stripe's webhook confirms it, and before this dial had a
  -- reader a reader could accrue without limit through that window. This figure
  -- is NAMED in the published Reader Terms, so moving it changes what the site
  -- has told its readers and the text moves with it — the procedure is in
  -- docs/adr/LEGAL-BRAKES.md.
  ('tab_ceiling_pence',              '800',  'Cap on a reader''s outstanding tab; a read that would exceed it is refused and the tab is collected first (£8.00)'),
  ('monthly_fallback_minimum_pence', '200',  'Minimum balance for time-based settlement trigger (£2.00)'),
  ('monthly_fallback_days',          '30',   'Days since last read before monthly settlement fires'),
  ('writer_payout_threshold_pence',  '2000', 'Writer balance threshold that triggers Stripe Connect transfer (£20.00)'),
  -- Writer Agreement 9.3 (operator decision A6, 2026-09-16), and BOTH figures
  -- are NAMED in the published text: "If you remain Unpayable for 6 months, we
  -- may withdraw your content from sale … after giving you at least 30 days'
  -- notice". So moving either changes what the site has told its writers and
  -- the text moves with it — the procedure is in docs/adr/LEGAL-BRAKES.md.
  -- They are dials rather than constants because the RIGHT figure is a legal
  -- and commercial judgement the operator may revisit, and because a notice
  -- period that cannot be lengthened in an emergency is not a notice period.
  ('unpayable_withdrawal_days',      '180',  'Days a Writer may remain unpayable before their paid access is withdrawn (Writer 9.3: six months)'),
  ('unpayable_notice_days',          '30',   'Days between the notice and the withdrawal (Writer 9.3: at least 30 days)'),
  ('platform_fee_bps',               '800',  'Platform cut in basis points (800 = 8%)')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Never seeded anywhere (2026-07-20): dials that only ever existed as a code
-- fallback, so `platform_config` was a promise the schema never kept. Each
-- default below is that exact fallback, so seeding changes no behaviour — it
-- only makes the dial real. Cited at its consumer.
--
-- NOTE, not silently reconciled: `feed_ingest_max_errors` (50) is read ONLY by
-- the email adapter (feed-ingest-email.ts), while every other adapter reads
-- `feed_ingest_max_error_count` (10, seeded by migration 052). Two keys, two
-- defaults, one meaning — email tolerates 5x the failures before deactivating a
-- source. Almost certainly an oversight, but unifying them changes live ingest
-- behaviour, so both are seeded at their current values and the discrepancy is
-- logged in CONSOLIDATED-TODO instead.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_ingest_rss_max_interval_seconds',     '3600', 'Adaptive RSS polling ceiling (feed-ingest-rss.ts)'),
  ('feed_ingest_rss_interval_backoff_factor',  '1.5',  'Adaptive RSS interval growth on an empty fetch (feed-ingest-rss.ts)'),
  ('feed_ingest_rss_interval_decay_factor',    '0.5',  'Adaptive RSS interval shrink on a productive fetch (feed-ingest-rss.ts)'),
  ('feed_ingest_nostr_backfill_hours',         '168',  'Lookback window for the nostr subscribe-time backfill (feed-ingest-nostr-backfill.ts)'),
  ('feed_ingest_engagement_max_items',         '2000', 'Max items per external engagement refresh run (external-engagement-refresh.ts)'),
  ('feed_ingest_max_errors',                   '50',   'Consecutive errors before deactivating an EMAIL source — see the note above (feed-ingest-email.ts)'),
  ('external_context_gc_retention_days',       '30',   'Age at which context-only hydration rows are reclaimed (external-context-gc.ts)'),
  ('external_sources_gc_grace_days',           '7',    'Grace period before an unsubscribed external source is culled (external-sources-gc.ts)'),
  ('external_sources_gc_cull_days',            '90',   'Age at which an unsubscribed external source is culled (external-sources-gc.ts)')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Waitlist operator digest (CLOSED-BETA-ADR §XI, D8.2, 2026-07-27).
-- Read by gateway/src/workers/waitlist-digest.ts, which runs on the hourly
-- worker tick and self-gates on this cadence. A dial rather than a constant
-- because the right cadence is a function of how fast the list is actually
-- moving — daily suits a beta taking a handful a day; a launch week may want
-- it hourly, and that should be an UPDATE, not a deploy.
--
-- Its companion `waitlist_digest_last_sent_at` is deliberately NOT here: that
-- is runtime state (the reported-up-to watermark), and its ABSENCE is the
-- meaningful cold-start value — "never sent". Same posture as payouts_halted.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('waitlist_digest_interval_hours',           '24',   'Minimum hours between waitlist operator digests. The digest also sends nothing when no one has joined since the last one (waitlist-digest.ts).')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Owner dashboard — UK tax / regulatory awareness thresholds (2026-07-22).
-- Read by GET /admin/dashboard/regulatory (gateway/src/routes/admin-dashboard.ts).
-- Values are the thresholds as of April 2026; they are dials (not code
-- constants) precisely so an accountant-verified correction is an UPDATE, not
-- a deploy. The dashboard is an awareness tool, not a tax calculator.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('tax_trading_allowance_pence',   '100000',   'UK trading income allowance (£1,000/yr). Platform fee revenue below this needs no reporting; above it, a self-assessment return is required.'),
  ('tax_vat_threshold_pence',       '9000000',  'UK VAT registration threshold (£90,000 rolling 12-month revenue). Compulsory registration above this.'),
  ('tax_vat_warning_pct',           '80',       'Percentage of the VAT threshold at which the dashboard shows an approaching warning.'),
  ('tax_corp_small_profits_pence',  '5000000',  'Corporation tax small profits threshold (£50,000 PROFIT — the dashboard compares revenue as a conservative proxy). 19% rate below.'),
  ('tax_corp_main_rate_pence',      '25000000', 'Corporation tax main rate threshold (£250,000 PROFIT). 25% above; marginal relief between the two thresholds.'),
  ('regulatory_holding_warning_days','14',      'Days of custodial holding (platform_settled reads not yet paid out) before the dashboard warns about PSR/EMR exposure.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Stripe funds segregation / allocated funds (FUNDS-SEGREGATION-INTEGRATION.md
-- §3.3b, §3.3c, §3.3d; migration 165). Read by payment-service's payout cycles
-- and the allocation-sync sweep. All three are dials rather than constants for
-- the reason the tuning-dials invariant gives: their right values are only
-- knowable by measuring live distributions, so retuning must be an UPDATE and
-- not a deploy. They are inert while STRIPE_ALLOCATED_FUNDS is off.
--
-- MEASURED 2026-07-30 — AND THE ANSWER WAS "NOT YET MEASURABLE". The baseline
-- queries (scripts/segregation-baseline.sql) were run against production and
-- every figure came back zero: no payouts in the window, no writers over
-- threshold, no connected accounts. Migration 165 IS applied (16:35:05 on
-- 2026-07-29) and the window is entirely post-165, so the plumbing is right —
-- there is simply no money yet, the site being gated pre-launch. So BOTH dials
-- below keep their placeholders, and the reason is now recorded rather than
-- merely pending: this is blocked on the platform having payout volume, not on
-- anyone doing a task. Re-run the queries once payouts flow. Read a zero here as
-- NO MEASUREMENT, never as perfect coverage — the same distinction
-- summariseResidual() makes by returning null on an empty denominator.
--
-- Corollary worth knowing before the first cycle: a residual share computed off
-- a *tiny* denominator is arithmetically fine and statistically meaningless, so
-- expect noise from this alert on the first few payout cycles. That is the
-- sample, not the threshold.
--
-- `allocated_residual_alert_bps` IS A PLACEHOLDER AND MUST BE RE-SET BEFORE THE
-- LIVE FLIP. The residual has a STRUCTURAL floor, not an exceptional one: every
-- credit-funded penny lands there by construction, forever (a subscription
-- charge covered by pre-paid credit has no settlement and therefore no charge to
-- draw on). Set it from 30 days of production data — Σ subscription_credit plus
-- charge-time-stamped subscription_earning, over Σ writer payouts for the same
-- window — with headroom above that floor. A threshold chosen without the
-- baseline fires on day one and gets muted, which is worse than no alert. Note
-- the spend→subscription conversion was dark from 2026-07-16 and its route
-- deleted 2026-09-29, so a trailing window measures only the live
-- logSubscriptionCharge branch — the honest CURRENT floor — and this dial must
-- be revisited if a new credit producer is ever written.
--
-- `payout_max_slices` bounds the tail, not the ordinary case: transfer volume
-- grows from O(writers) to roughly O(writers × charges drawn), and a writer
-- whose earnings span hundreds of charges should roll the excess to the next
-- cycle rather than be paid in hundreds of transfers. Pick the starting value
-- from the real distribution (`SELECT count(DISTINCT tab_settlement_id)` per
-- unpaid writer balance) — 20 covers the dev distribution and is a guess about
-- production.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('payout_max_slices',                '20',   'Max child transfers per payout under funds segregation. Units past the cap are un-claimed inside the reserve transaction and roll to the next cycle (payout.ts / allocation-packer.ts).'),
  ('allocated_residual_alert_bps',     '2000', 'PLACEHOLDER — re-set from a 30-day production baseline before the live flip. Rolling-30-day share of payout value funded from platform balance rather than allocated funds, above which the residual metric alerts. Alert only; never halts payouts (a large residual means the money is right and the SEGREGATION COVERAGE is poor).'),
  ('allocation_sync_freshness_hours',  '24',   'How stale a settlement''s allocated_pence may be before the allocation-sync sweep re-reads it from Stripe. Lower = more Stripe calls, fresher drawing budget (settlement.ts::syncAllocations).')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Payout-halt escalation (PAYMENT-PERIMETER-ADR W4, migration 175).
--
-- A halt that is never cleared is indistinguishable from a policy of not
-- paying, and nothing in the system noticed: the banner displayed the halt and
-- no job ever compared its age. Dev sat globally halted for a fortnight from
-- 2026-07-17 — every payout cycle a no-op, the reconciliation clean each time
-- (a human had fixed the data and not the flag), nothing wrong with the payout
-- code at all (scripts/backfill-seed-opening-balances.ts header).
--
-- It is a DIAL rather than a constant because the right value is a property of
-- how the operator is staffed, not of the code: 24h says "a halt should not
-- survive a working day unlooked-at", which is the same urgency the alert-tier
-- reconciliation incidents already carry. Lower it once someone is on call;
-- raise it and you are choosing to let money sit still for longer.
--
-- The reconciler checks this on EVERY run, including clean ones — a stale halt
-- is precisely the state that produces clean runs forever.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('payout_halt_escalation_hours',     '24',   'Hours a payout halt (the global payouts_halted flag or a payouts_halted_accounts row) may stand before the ledger reconciler escalates it under the payout_halt_stale alert marker. A halt nobody clears is a policy of not paying (reconcile-ledger.ts::escalateStaleHalts).')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Feed formulas — the publishable source cap (FEED-FORMULAS-ADR §6).
--
-- Sized by REDEEM LATENCY, not by storage. Redemption resolves N sources
-- through addSource one at a time, and a genuinely new identity is probed, so
-- the cap is really "how long may a redeem request take in the worst case".
-- In practice almost every source in a v1 formula is already held healthy by
-- this instance (the author holds it), which short-circuits the probe — 200
-- bounds the pathological case rather than the normal one.
--
-- It is a dial because the right number is only knowable by watching real
-- redemptions: lower it if redeems start timing out, raise it once redemption
-- moves to a background job. There is no per-feed source cap anywhere else in
-- the system, so this is the first thing that stresses that.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_formula_max_sources',        '200',  'Maximum portable sources a feed formula may carry. Bounds worst-case redeem latency (N serial addSource calls, each probing a genuinely new identity), not storage. Read by gateway formulas.ts::formulaMaxSources.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Ingest liveness — how stale the feed-ingest heartbeat may get before the
-- owner dashboard calls it down (prod incident 2026-08-11: the worker was
-- stopped by a stray SIGTERM and nothing noticed for 21 hours).
--
-- `feed_ingest_heartbeat` itself is runtime STATE and is deliberately absent
-- from this file (like payouts_halted): the worker upserts it every 60s, and
-- the alarm is its ABSENCE, which no seed should ever pre-satisfy.
--
-- This is the threshold, and it is a dial because the right number is only
-- knowable by watching the real tick: the poll is scheduled every 60s but a
-- long-running tick, a busy worker or a slow database all stretch the gap, and
-- an alert that fires on ordinary jitter is one an operator learns to ignore —
-- which is the failure mode this whole check exists to end. 600s = ten missed
-- ticks: comfortably past jitter, far short of the 21 hours it took a human to
-- spot the last outage.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('ingest_heartbeat_alert_seconds',  '600',  'Age (seconds) at which the feed_ingest_heartbeat is reported DOWN on /admin/overview. The worker stamps the heartbeat every 60s; ten missed ticks is past jitter. Read by gateway admin-dashboard.ts.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Dead background jobs — the arrival window (CONSOLIDATED-TODO §8.15).
--
-- The heartbeat above says whether the worker is RUNNING. It cannot say whether
-- the worker is failing everything it picks up: a job that exhausts its attempts
-- stops being retried and sits in graphile_worker's table forever, telling
-- nobody. `relay_outbox_prune` was red for 84 consecutive nights on prod that
-- way, and the fault underneath it had silently switched off members' feeds.
--
-- This is NOT an alarm threshold, and the distinction is the whole design. The
-- two arms of that surface are discriminated structurally, not by a number: a
-- CRON task's dead row means a scheduled run did not happen and alarms at one,
-- while a PER-ENTITY row (one source among hundreds) is informational, because a
-- threshold on a cumulative pile is red from the first day and gets learned past
-- — the exact failure the alarm exists to avoid.
--
-- What this dial sets is the window over which NEW deaths are counted, because
-- the pile is cumulative and the rate is the signal: dev's 1038 rows accrued
-- since July say nothing, the nine that arrived today say something. A dial
-- because the right window depends on cadence and on how often an operator
-- looks — 24h suits a daily glance; widen it if the page is checked weekly, and
-- note that most of that pile is jobs abandoned by worker restarts rather than
-- jobs that failed, which arrive in spikes and not at a steady rate.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('dead_job_arrival_window_hours',   '24',   'Window (hours) over which newly-dead graphile jobs are counted as recent arrivals on /admin/overview. Not a threshold: the cron arm alarms at one dead row regardless, and the per-entity arm never alarms. Read by gateway admin-dashboard.ts.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Jetstream replay cap (dev diagnosis 2026-08-12).
--
-- A reconnect resumes from the OLDEST cursor across active atproto sources so
-- that no source misses events — but a cursor only advances when that account
-- posts, so the minimum is the least active account's last post and it ages
-- without bound. Past 150 DIDs the listener takes the unfiltered firehose, so
-- an old cursor asks Bluesky to replay a month of every post on the network:
-- measured at 113 MB per 30s on dev, roughly fifteen hours to reach live, and
-- restarting begins it again. Worse, the replayed events are already held, so
-- they insert nothing and raise no cursor — Bluesky ingest looks dead while the
-- socket works perfectly hard.
--
-- A dial because it trades two real costs against each other and the exchange
-- rate is only knowable live: raise it to replay a longer outage through the
-- firehose, lower it to reach live sooner after one. Past the cap the
-- per-source poll fallback is the better backfill anyway — it fetches one
-- account's history rather than filtering the planet's.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('feed_ingest_atproto_max_replay_hours', '24', 'How far back a Jetstream reconnect may resume. Caps the oldest per-source cursor, which otherwise ages without bound and makes every reconnect replay weeks of the whole firehose. Read by feed-ingest listener.ts::resumePoint.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Cross-source dedup — the confidence below which a recorded identity link
-- suppresses nothing (§6.1 + §6.3).
--
-- Dedup hides content, so the question a link answers is not "are these two
-- posts the same text" (they demonstrably are — that is what the fingerprint
-- measures) but "is this the same PERSON". The fingerprint cannot answer the
-- second and never could: two accounts posting the same headline is ordinary,
-- and a hand read of dev's multi-source fingerprint groups found 88 of 89 were
-- different authors syndicating the same tech-news line. All of the identity
-- claim therefore rides on the link, and the floor is what stops the weakest
-- kind of link — a `domain_match` guessed from a shared website, confidence
-- 0.6 — from silently deleting a stranger's post from somebody's feed.
--
-- 0.9 admits `bridge` (0.95: a bridge mirror embeds the original identity, so
-- it is a decode rather than a guess) and `user_asserted` (1.0: the reader
-- said so), and excludes `domain_match`. It is a dial because the right answer
-- depends on how domain_match performs against real feeds, which nobody can
-- know until IDENTITY_LINK_DETECT_ENABLED has run somewhere with volume:
-- measure first, then lower it to ~0.5 to switch domain-matching on. The
-- detector keeps running and keeps recording either way — a 0.6 link is
-- evidence worth having, just not an instruction.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('dedup_min_confidence',           '0.9',  'Minimum external_identity_links.confidence for a link to suppress a cross-posted duplicate. 0.9 admits bridge (0.95) and user_asserted (1.0) and excludes domain_match (0.6). Read by gateway dedup-sql.ts::dedupMinConfidence.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Recent reading — how long a piece stays in the reader's log (D5).
--
-- The window is the whole of the privacy posture. Recent reading is on by
-- default because a log you had to predict you would want is empty on the day
-- you finally want it; what makes that default defensible rather than
-- acquisitive is that it forgets. Widening this dial re-opens D1 rather than
-- extending it.
--
-- It is also the difference between a rounding error and the largest table on
-- the box. At 323 bytes/row, measured on real post_id values with both indexes:
-- seven days of heavy reading (100 pieces/day) is 226 KB per reader, 2.3 GB at
-- ten thousand readers. Unbounded, the same reader costs ~12 MB per YEAR each
-- and never stops — 118 GB at the same population.
--
-- Read by the gateway retention sweep (reading-log-sweep.ts) and nothing else,
-- which is the whole reader set a dial needs: a seeded key no code consults is
-- a dial whose UPDATE succeeds, reports nothing and changes nothing.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('reading_log_retention_days', '7', 'How many days a piece stays in a reader''s Recent reading log, measured on its LATEST open so a piece returned to never ages out. Also the age at which a reading_positions row is swept, which since migration 189 has no other reaper. Read by gateway workers/reading-log-sweep.ts.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Pledge drives — the ceiling on a single pledge (MIRROR-AUDIT §3 Money, S14).
--
-- A pledge is a promise that becomes real money at fulfilment: publishing the
-- article inserts a read_event and debits the pledger's tab by the full amount.
-- The route bounded it only at `min(1)`, so a slipped decimal point promised
-- £5,000 as easily as £50 and nothing questioned it until the debt was on
-- somebody's tab.
--
-- £100 is the beta figure and deliberately generous — the point of the cap is
-- the fat finger and the runaway client, not the enthusiastic backer. It is a
-- dial rather than a literal because the right ceiling is only knowable by
-- watching what people actually pledge, and pledges are parked behind
-- PLEDGES_ENABLED, so there is no distribution to read yet.
--
-- Read by gateway routes/drives.ts::pledgeMaxPence, whose in-code fallback is
-- parity-tested against this line (gateway/tests/config-fallback-parity.test.ts).
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('pledge_max_pence', '10000', 'Ceiling on a single pledge to a drive (£100.00). Fulfilment turns a pledge into a tab debit, so this bounds what one gesture can put on a reader''s tab. Read by gateway routes/drives.ts::pledgeMaxPence.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Linked-account notifications (CROSS-NETWORK-ROUNDTRIP-ADR rung C).
--
-- feed-ingest's linked_notifications_poll asks every active Bluesky/Mastodon
-- presence's own network "what was addressed to this person" and brings the
-- replies, mentions and quotes home as notifications.
--
-- The INTERVAL is how stale a notification may be before a member sees it, and
-- how many authenticated requests we spend on their behalf (one list call per
-- presence per interval, plus a lookup per Mastodon reply). 300s is a guess
-- until there is a distribution to read: a reply twenty minutes late reads as
-- broken, one five minutes late as ordinary.
--
-- STALE INTERVALS is the liveness threshold: a presence whose poll has not
-- SUCCEEDED for this many intervals is counted DOWN on /admin/overview (the
-- heartbeat is `network_presences.notifications_polled_at`, stamped only on a
-- success). Six is past ordinary jitter and a transient outage at the far end.
--
-- BACKFILL HOURS bounds a presence's FIRST poll: without it, linking an old
-- account would dump its whole history into the panel as new. Three days
-- catches a reply sent while the member was away from the platform, which is
-- the case the rung exists for.
--
-- The poller (feed-ingest tasks/linked-notifications-poll.ts) reads the
-- interval and the backfill; the dashboard (gateway routes/admin-dashboard.ts)
-- reads the interval and the stale threshold. The fallbacks in both are
-- parity-tested against this file.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('linked_notifications_poll_seconds',     '300', 'How often (seconds) feed-ingest polls each active Bluesky/Mastodon presence for replies, mentions and quotes addressed to its member. Read by feed-ingest linked-notifications-poll.ts and gateway admin-dashboard.ts.'),
  ('linked_notifications_stale_intervals',  '6',   'A presence whose notification poll has not succeeded for this many poll intervals is counted DOWN on /admin/overview. Read by gateway admin-dashboard.ts.'),
  ('linked_notifications_backfill_hours',   '72',  'How far back a presence''s FIRST notification poll reaches, so linking an account does not replay its whole history as new. Read by feed-ingest linked-notifications-poll.ts.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The key export waits after an email change (migration 273).
--
-- Login is by email and the export's confirmation is mailed to the account's
-- current address, so a change of address is the one act that moves that
-- channel. For this many days after a change nobody has undone, the export is
-- paused, and the old address's undo link stays good for the same length. The
-- custodial key cannot be rotated, so the undo has to land before the key can
-- leave. Seven days is long enough for a member who reads email weekly; an
-- exchange-style 72 hours is the shorter end. 0 turns the hold off. Read by
-- gateway lib/email-change-hold.ts; its fallback is parity-tested.
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('email_change_export_hold_days', '7', 'Days after a sign-in email change during which the account export is paused, and for which the old address''s undo link stays valid. 0 turns the hold off. Read by gateway lib/email-change-hold.ts.')
ON CONFLICT (key) DO NOTHING;
