import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { pool } from "@platform-pub/shared/db/client.js";
import { readNetSql } from "@platform-pub/shared/lib/per-read-net.js";

export async function myAccountRoutes(app: FastifyInstance) {
  // GET /my/tab
  app.get("/my/tab", { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub;
    try {
      // Phase-3 ledger cutover: the reader-facing "what you owe" balance is now
      // read from ledger_reader_balance (−SUM of the reader's tab-affecting
      // ledger entries, opening-balance backfilled in migration 121), not the
      // reading_tabs.balance_pence running total. The column still exists and is
      // still mutated — it stays the locked operational total settlement reserves
      // against (SELECT … FOR UPDATE) — but the ledger view is now the source of
      // truth for display. They agree to the penny by construction (every tab
      // movement posts a mirror entry; the backfill aligned pre-Phase-1 history).
      const account = await pool.query(
        `SELECT a.free_allowance_remaining_pence,
                a.free_allowance_granted_pence,
                a.card_action_required_at,
                COALESCE(lrb.balance_pence, 0) AS balance_pence
         FROM accounts a
         LEFT JOIN ledger_reader_balance lrb ON lrb.account_id = a.id
         WHERE a.id = $1`,
        [userId],
      );
      const reads = await pool.query(
        `
        SELECT r.id as "readId", a.title as "articleTitle", a.nostr_d_tag as "articleDTag",
               w.display_name as "writerDisplayName", w.username as "writerUsername",
               r.chargeable_pence as "chargePence", r.read_at as "readAt",
               ts.settled_at as "settledAt",
               r.is_subscription_read as "isSubscriptionRead"
        FROM read_events r
        JOIN articles a ON a.id = r.article_id
        JOIN accounts w ON w.id = r.writer_id
        LEFT JOIN tab_settlements ts ON ts.id = r.tab_settlement_id
        WHERE r.reader_id = $1
        ORDER BY r.read_at DESC
        LIMIT 100
      `,
        [userId],
      );
      const settled = reads.rows.find((r: any) => r.settledAt);
      return reply.send({
        tabBalancePence: account.rows[0]?.balance_pence ?? 0,
        freeAllowanceRemainingPence:
          account.rows[0]?.free_allowance_remaining_pence ?? 0,
        // The gauge's denominator, and it is THIS READER'S grant (migration 169)
        // rather than the current `free_allowance_pence` dial. The two differ the
        // moment an operator retunes: sending the live dial would tell a reader
        // gifted £5 that they had been gifted £7.50, restating a historical fact
        // — and the gift is the one thing the free-allowance invariant says is
        // never revisited. It was a `500` hardcoded in LedgerPanel before, which
        // was right only for as long as nothing could change it.
        freeAllowanceTotalPence:
          account.rows[0]?.free_allowance_granted_pence ?? 0,
        lastSettledAt: settled?.settledAt || null,
        // Set when an off-session settlement charge terminally declined; the tab
        // is frozen (settlement backs off) until the reader re-attaches a card.
        // Frontend prompts a card re-auth when non-null. STRIPE audit S1.
        cardActionRequiredAt: account.rows[0]?.card_action_required_at ?? null,
        reads: reads.rows,
      });
    } catch (err) {
      req.log.error({ err }, "Failed to fetch tab");
      return reply.status(500).send({ error: "Failed to fetch tab data" });
    }
  });

  // =========================================================================
  // GET /my/account-statement — unified credits, debits & paginated statement
  // =========================================================================
  app.get<{
    Querystring: {
      filter?: string;
      limit?: string;
      offset?: string;
      include_free_reads?: string;
    };
  }>(
    "/my/account-statement",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const filter = req.query.filter ?? "all"; // 'all' | 'credits' | 'debits'
      const limit = Math.min(parseInt(req.query.limit ?? "30", 10) || 30, 200);
      const offset = parseInt(req.query.offset ?? "0", 10) || 0;
      const includeFreeReads = req.query.include_free_reads === "true";

      try {
        // 1. Account info + last settlement date
        const accountRow = await pool.query<{
          created_at: string;
          free_allowance_remaining_pence: number;
        }>(
          `SELECT created_at, free_allowance_remaining_pence FROM accounts WHERE id = $1`,
          [userId],
        );
        if (accountRow.rowCount === 0) {
          return reply.status(404).send({ error: "Account not found" });
        }

        const settlementRow = await pool.query<{ settled_at: string }>(
          `SELECT settled_at FROM tab_settlements WHERE reader_id = $1 ORDER BY settled_at DESC LIMIT 1`,
          [userId],
        );
        const lastSettledAt = settlementRow.rows[0]?.settled_at ?? null;

        // Platform fee rate
        const configRow = await pool.query<{ value: string }>(
          `SELECT value FROM platform_config WHERE key = 'platform_fee_bps'`,
        );
        const feeBps = parseInt(configRow.rows[0]?.value ?? "800", 10);

        // 2. Build the unified statement via UNION ALL
        //    Each sub-query produces: id, date, type, category, description, amount_pence, link

        const statementSQL = `
          WITH statement AS (
            -- Free allowance credit — what THIS reader was granted at signup
            -- (migration 169), not a literal and not the current dial: this is
            -- a statement line, so it must say what actually happened to them.
            SELECT
              'free-allowance' AS id,
              a.created_at AS date,
              'credit' AS type,
              'free_allowance' AS category,
              'Starting credit' AS description,
              a.free_allowance_granted_pence AS amount_pence,
              NULL AS link
            FROM accounts a
            WHERE a.id = $1

            UNION ALL

            -- Article read debits (reader pays to read)
            SELECT
              'read-' || re.id AS id,
              re.read_at AS date,
              'debit' AS type,
              'article_read' AS category,
              art.title AS description,
              re.chargeable_pence AS amount_pence,
              '/article/' || art.nostr_d_tag AS link
            FROM read_events re
            JOIN articles art ON art.id = re.article_id
            WHERE re.reader_id = $1
              AND re.chargeable_pence > 0
              AND re.is_subscription_read = FALSE

            ${
              includeFreeReads
                ? `
            UNION ALL

            -- Free reads (no charge)
            SELECT
              'freeread-' || re.id AS id,
              re.read_at AS date,
              'debit' AS type,
              'free_read' AS category,
              art.title AS description,
              0 AS amount_pence,
              '/article/' || art.nostr_d_tag AS link
            FROM read_events re
            JOIN articles art ON art.id = re.article_id
            WHERE re.reader_id = $1
              AND (re.chargeable_pence = 0 OR re.is_subscription_read = TRUE)
            `
                : ""
            }

            UNION ALL

            -- Article earning credits (writer earns from readers, after platform fee)
            SELECT
              'earning-' || re.id AS id,
              re.read_at AS date,
              'credit' AS type,
              'article_earning' AS category,
              COALESCE(reader.display_name, reader.username, 'Reader') || ' read ' || art.title AS description,
              -- Tribute carve (Upstream Edges Phase 3): a tributed read's earning
              -- credit is net of the inspirer-bound (released|paid) shares.
              -- Dial A: released|paid are the only accrual states. No-op when no
              -- accruals exist (feature dark).
              (${readNetSql("re.chargeable_pence", "$2")}
                - COALESCE((SELECT SUM(ta.amount_pence) FROM tribute_accruals ta
                            WHERE ta.read_event_id = re.id
                              AND ta.state IN ('released', 'paid')), 0))::int AS amount_pence,
              '/article/' || art.nostr_d_tag AS link
            FROM read_events re
            JOIN articles art ON art.id = re.article_id
            JOIN accounts reader ON reader.id = re.reader_id
            WHERE re.writer_id = $1
              AND re.reader_id != $1
              AND re.chargeable_pence > 0
              AND re.state IN ('platform_settled', 'writer_paid')

            UNION ALL

            -- Subscription charge debits (reader pays for subscription)
            SELECT
              'subcharge-' || se.id AS id,
              se.created_at AS date,
              'debit' AS type,
              'subscription_charge' AS category,
              'Subscription to ' || COALESCE(w.display_name, w.username) AS description,
              se.amount_pence,
              '/' || w.username AS link
            FROM subscription_events se
            JOIN accounts w ON w.id = se.writer_id
            WHERE se.reader_id = $1
              AND se.event_type = 'subscription_charge'

            UNION ALL

            -- Subscription earning credits (writer earns from subscriber)
            SELECT
              'subearning-' || se.id AS id,
              se.created_at AS date,
              'credit' AS type,
              'subscription_earning' AS category,
              'Subscriber: ' || COALESCE(r.display_name, r.username) AS description,
              se.amount_pence,
              '/' || r.username AS link
            FROM subscription_events se
            JOIN accounts r ON r.id = se.reader_id
            WHERE se.writer_id = $1
              AND se.event_type = 'subscription_earning'

            UNION ALL

            -- Vote charge debits (voter pays)
            SELECT
              'votecharge-' || vc.id AS id,
              vc.created_at AS date,
              'debit' AS type,
              'vote_charge' AS category,
              CASE v.direction WHEN 'up' THEN 'Upvote' ELSE 'Downvote' END
                || COALESCE(': ' || art.title, '') AS description,
              vc.amount_pence::int AS amount_pence,
              CASE WHEN art.nostr_d_tag IS NOT NULL THEN '/article/' || art.nostr_d_tag ELSE NULL END AS link
            FROM vote_charges vc
            JOIN votes v ON v.id = vc.vote_id
            LEFT JOIN articles art ON art.nostr_event_id = v.target_nostr_event_id
            WHERE vc.voter_id = $1

            UNION ALL

            -- Vote earning credits (author receives upvote money)
            SELECT
              'voteearning-' || vc.id AS id,
              vc.created_at AS date,
              'credit' AS type,
              'vote_earning' AS category,
              'Upvote from ' || COALESCE(voter.display_name, voter.username, 'Someone')
                || COALESCE(' on ' || art.title, '') AS description,
              vc.amount_pence::int AS amount_pence,
              CASE WHEN art.nostr_d_tag IS NOT NULL THEN '/article/' || art.nostr_d_tag ELSE NULL END AS link
            FROM vote_charges vc
            JOIN votes v ON v.id = vc.vote_id
            JOIN accounts voter ON voter.id = vc.voter_id
            LEFT JOIN articles art ON art.nostr_event_id = v.target_nostr_event_id
            WHERE vc.recipient_id = $1

            UNION ALL

            -- Settlements (balance cleared via Stripe)
            SELECT
              'settlement-' || ts.id AS id,
              ts.settled_at AS date,
              'settlement' AS type,
              'settlement' AS category,
              'Balance settled' AS description,
              ts.amount_pence,
              NULL AS link
            FROM tab_settlements ts
            WHERE ts.reader_id = $1
          )
          SELECT * FROM statement
          ${filter === "credits" ? "WHERE type = 'credit'" : filter === "debits" ? "WHERE type = 'debit'" : ""}
          ORDER BY date DESC
        `;

        // Get total count for pagination
        const countSQL = `SELECT COUNT(*) AS total FROM (${statementSQL}) AS counted`;
        const countResult = await pool.query<{ total: string }>(countSQL, [
          userId,
          feeBps,
        ]);
        const totalEntries = parseInt(countResult.rows[0].total, 10);

        // Get paginated entries
        const entriesResult = await pool.query(
          `${statementSQL} LIMIT $3 OFFSET $4`,
          [userId, feeBps, limit, offset],
        );

        // 3. Compute summary totals (since last settlement, unfiltered)
        const summarySQL = `
          WITH statement AS (
            -- The reader's OWN grant, never the dial and never a literal: the
            -- entry list above reads the same column, and a literal here made
            -- the two disagree the moment free_allowance_pence was retuned —
            -- which is the only reason that dial was made live at all.
            SELECT 'credit' AS type,
                   a.free_allowance_granted_pence AS amount_pence,
                   a.created_at AS date
            FROM accounts a WHERE a.id = $1

            UNION ALL

            SELECT 'debit', re.chargeable_pence, re.read_at
            FROM read_events re
            WHERE re.reader_id = $1 AND re.chargeable_pence > 0 AND re.is_subscription_read = FALSE

            UNION ALL

            SELECT 'credit',
              (${readNetSql("re.chargeable_pence", "$3")}
                - COALESCE((SELECT SUM(ta.amount_pence) FROM tribute_accruals ta
                            WHERE ta.read_event_id = re.id
                              AND ta.state IN ('released', 'paid')), 0))::int,
              re.read_at
            FROM read_events re
            WHERE re.writer_id = $1 AND re.reader_id != $1 AND re.chargeable_pence > 0
              AND re.state IN ('platform_settled', 'writer_paid')

            UNION ALL

            SELECT 'debit', se.amount_pence, se.created_at
            FROM subscription_events se
            WHERE se.reader_id = $1 AND se.event_type = 'subscription_charge'

            UNION ALL

            SELECT 'credit', se.amount_pence, se.created_at
            FROM subscription_events se
            WHERE se.writer_id = $1 AND se.event_type = 'subscription_earning'

            UNION ALL

            SELECT 'debit', vc.amount_pence::int, vc.created_at
            FROM vote_charges vc WHERE vc.voter_id = $1

            UNION ALL

            SELECT 'credit', vc.amount_pence::int, vc.created_at
            FROM vote_charges vc WHERE vc.recipient_id = $1
          )
          SELECT
            COALESCE(SUM(CASE WHEN type = 'credit' THEN amount_pence ELSE 0 END), 0) AS credits_total,
            COALESCE(SUM(CASE WHEN type = 'debit' THEN amount_pence ELSE 0 END), 0) AS debits_total
          FROM statement
          WHERE date > COALESCE($2::timestamptz, '1970-01-01'::timestamptz)
        `;
        const summaryResult = await pool.query<{
          credits_total: string;
          debits_total: string;
        }>(summarySQL, [userId, lastSettledAt, feeBps]);
        const creditsTotalPence = parseInt(
          summaryResult.rows[0].credits_total,
          10,
        );
        const debitsTotalPence = parseInt(
          summaryResult.rows[0].debits_total,
          10,
        );

        return reply.send({
          summary: {
            creditsTotalPence,
            debitsTotalPence,
            balancePence: creditsTotalPence - debitsTotalPence,
            lastSettledAt,
          },
          entries: entriesResult.rows,
          totalEntries,
          hasMore: offset + limit < totalEntries,
        });
      } catch (err) {
        req.log.error({ err }, "Failed to fetch account statement");
        return reply
          .status(500)
          .send({ error: "Failed to fetch account statement" });
      }
    },
  );
}
