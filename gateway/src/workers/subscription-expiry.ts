import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { signSubscriptionEvent } from "../lib/nostr-publisher.js";
import { enqueueRelayPublish } from "@platform-pub/shared/lib/relay-outbox.js";
import {
  sendSubscriptionRenewedEmail,
  sendSubscriptionExpiryWarningEmail,
  sendSubscriptionLapsedNotForSaleEmail,
} from "@platform-pub/shared/lib/subscription-emails.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { publicationsEnabled } from "@platform-pub/shared/lib/env.js";
import { advanceSubscriptionPeriod } from "@platform-pub/shared/lib/subscription-period.js";
import { logSubscriptionCharge } from "../routes/subscriptions/index.js";

// =============================================================================
// Subscription renewal and expiry — runs hourly from gateway/index.ts under
// an advisory lock.
//
// 1. Auto-renew: active subscriptions past period end with auto_renew = true
//    → charge reader, roll period forward, log events, publish Nostr attestation
// 2. Expire: active/cancelled subscriptions past period end with auto_renew = false
//    → set status to 'expired'
// 3. Expiry warnings: send email 3 days before period end for non-auto-renewing
// =============================================================================

export async function expireAndRenewSubscriptions(): Promise<number> {
  let processed = 0;

  // --- Phase 1: Auto-renew subscriptions ---
  // LEFT JOIN both targets: a subscription is to a writer (writer_id) XOR a
  // publication (publication_id) — see subscriptions_target_check. Inner-joining
  // accounts would silently drop every publication subscription from renewal.
  const renewable = await pool.query<{
    id: string;
    reader_id: string;
    writer_id: string | null;
    publication_id: string | null;
    price_pence: number;
    current_period_end: Date;
    reader_pubkey: string;
    writer_pubkey: string;
    subscription_period: string;
    offer_periods_remaining: number | null;
    writer_standard_price: number | null;
    writer_annual_discount_pct: number | null;
    reader_stripe_customer_id: string | null;
    reader_card_action_required_at: Date | null;
    period_anchor_day: number;
    target_status: string | null;
    writer_paid_access_withdrawn_at: Date | null;
  }>(
    `SELECT s.id, s.reader_id, s.writer_id, s.publication_id, s.price_pence,
            s.current_period_end, s.period_anchor_day,
            w.paid_access_withdrawn_at AS writer_paid_access_withdrawn_at,
            r.stripe_customer_id AS reader_stripe_customer_id,
            r.card_action_required_at AS reader_card_action_required_at,
            r.nostr_pubkey AS reader_pubkey,
            COALESCE(w.nostr_pubkey, p.nostr_pubkey) AS writer_pubkey,
            COALESCE(s.subscription_period, 'monthly') AS subscription_period,
            s.offer_periods_remaining,
            w.subscription_price_pence AS writer_standard_price,
            w.annual_discount_pct AS writer_annual_discount_pct,
            COALESCE(w.status::text, p.status) AS target_status
     FROM subscriptions s
     JOIN accounts r ON r.id = s.reader_id
     LEFT JOIN accounts w ON w.id = s.writer_id
     LEFT JOIN publications p ON p.id = s.publication_id
     WHERE s.status = 'active'
       AND s.auto_renew = TRUE
       AND s.current_period_end < now()`,
  );

  for (const sub of renewable.rows) {
    // Publications suspended 2026-08-31 (PUBLICATIONS-SUSPENSION-PLAN.md §1 H2).
    // A publication subscription is recurring TAB DEBT, and the surface it buys
    // 404s while the system is dark — charging a reader for pages they cannot
    // reach is the failure this gate exists to prevent. Expire rather than
    // renew, reusing the card-less terminal state above (status 'expired',
    // auto_renew FALSE, same period-end guard for idempotency).
    //
    // Deliberately expire, not skip: skipping would leave the row 'active' and
    // past its period end, so it would be re-selected every hour forever and
    // silently resume charging the moment the flag flips back — a reader billed
    // for months they were never served. Expiry is the honest terminal state;
    // reinstatement re-subscribes deliberately (§8 item 3).
    if (sub.publication_id && !publicationsEnabled()) {
      await pool
        .query(
          `UPDATE subscriptions
           SET status = 'expired', auto_renew = FALSE, updated_at = now()
           WHERE id = $1 AND status = 'active' AND current_period_end < now()`,
          [sub.id],
        )
        .catch((err) =>
          logger.error(
            { err, subscriptionId: sub.id },
            "Failed to expire publication subscription while publications are suspended",
          ),
        );
      logger.warn(
        {
          subscriptionId: sub.id,
          readerId: sub.reader_id,
          publicationId: sub.publication_id,
        },
        "Subscription expired at renewal — publications are suspended (not charged)",
      );
      processed++;
      continue;
    }

    // The thing subscribed to must still be LIVE at renewal (§3 money, S14).
    // The renewable SELECT left-joins both targets and read neither's status,
    // so a reader kept paying a writer whose account moderation had suspended
    // or whose owner had deleted it — for a byline that publishes nothing and
    // whose profile the rest of the site already refuses (`status = 'active'`
    // is the site-wide predicate: author-resolve, search, follows, export).
    // The writer's earning accrued all the same, so the money moved too.
    //
    // Expire rather than skip, for the reason spelled out in the publications
    // gate above: a skip leaves the row 'active' and past its period end, so it
    // is re-selected every hour forever and silently resumes charging the day
    // the account comes back. NULL is included deliberately — a target row that
    // is absent entirely is not a target we may charge for either. (The
    // publication arm is dead while publications are suspended, since the gate
    // above expires every publication subscription first; it is written now
    // because it is the same defect one column over, and reinstatement must not
    // have to rediscover it.)
    if (sub.target_status !== "active") {
      await pool
        .query(
          `UPDATE subscriptions
           SET status = 'expired', auto_renew = FALSE, updated_at = now()
           WHERE id = $1 AND status = 'active' AND current_period_end < now()`,
          [sub.id],
        )
        .catch((err) =>
          logger.error(
            { err, subscriptionId: sub.id },
            "Failed to expire subscription whose target is no longer active",
          ),
        );
      logger.warn(
        {
          subscriptionId: sub.id,
          readerId: sub.reader_id,
          writerId: sub.writer_id,
          publicationId: sub.publication_id,
          targetStatus: sub.target_status,
        },
        "Subscription expired at renewal — the writer/publication is no longer active (not charged)",
      );
      processed++;
      continue;
    }

    // Collection gate (2026-07-06 audit P0): never renew-charge a reader with
    // no card on file — the charge would be uncollectible tab debt (settlement
    // skips card-less accounts) while the writer's earning became payable.
    // Subscribing now requires a card, so this only catches a card detached
    // since; expire the subscription instead of charging (same terminal state
    // as a renewal that failed both attempts below). The period-end guard keeps
    // it idempotent against a concurrent cycle.
    // Writer 9.3 — paid access to this writer's work is withdrawn (L5.6; §0z
    // item 10). A renewal is a sale, so the subscription lapses at period end,
    // NOT charged, and the reader is told why in the terms that are theirs to
    // know. What they already unlocked stays unlocked (the gate pass's free
    // path runs before its withdrawal check). Before the card checks: the
    // reason this is not renewed is not the reader's card.
    if (sub.writer_id && sub.writer_paid_access_withdrawn_at) {
      await pool
        .query(
          `UPDATE subscriptions
           SET status = 'expired', auto_renew = FALSE, updated_at = now()
           WHERE id = $1 AND status = 'active' AND current_period_end < now()`,
          [sub.id],
        )
        .catch((err) =>
          logger.error(
            { err, subscriptionId: sub.id },
            "Failed to expire subscription to a writer whose paid access is withdrawn",
          ),
        );
      sendSubscriptionLapsedNotForSaleEmail(sub.reader_id, sub.writer_id).catch((err) =>
        logger.warn(
          { err, subscriptionId: sub.id },
          "Subscription-lapsed notice failed",
        ),
      );
      logger.warn(
        {
          subscriptionId: sub.id,
          readerId: sub.reader_id,
          writerId: sub.writer_id,
          withdrawnSince: sub.writer_paid_access_withdrawn_at,
        },
        "Subscription expired at renewal — the writer's paid access is withdrawn (Writer 9.3; not charged)",
      );
      processed++;
      continue;
    }

    if (!sub.reader_stripe_customer_id) {
      await pool
        .query(
          `UPDATE subscriptions
           SET status = 'expired', auto_renew = FALSE, updated_at = now()
           WHERE id = $1 AND status = 'active' AND current_period_end < now()`,
          [sub.id],
        )
        .catch((err) =>
          logger.error(
            { err, subscriptionId: sub.id },
            "Failed to expire card-less subscription",
          ),
        );
      logger.warn(
        { subscriptionId: sub.id, readerId: sub.reader_id },
        "Subscription expired at renewal — reader has no card on file (charge would be uncollectible)",
      );
      processed++;
      continue;
    }

    // Reader Terms 6.1, the renewal half. The card-less arm above catches a
    // reader with no card at all; this one catches the reader whose card
    // TERMINALLY DECLINED — settlement has backed off their tab since, so a
    // renewal charge would be a debt we have already been told we cannot
    // collect, landing on a reader who has been shown "your reading tab is
    // paused". Expire rather than skip, for the reason the two arms above
    // spell out: a skip leaves the row active and past its period end, so it is
    // re-selected hourly for ever and resumes charging the day the flag clears
    // — which for this flag is the day a NEW card arrives, at which point the
    // reader has chosen nothing about a subscription that lapsed months ago.
    //
    // No email of its own: the reader already has the standing card-declined
    // prompt on every money surface, which is the action that would fix this,
    // and the expiry warning is phase 3's job for subscriptions ENDING on
    // schedule. Same disposition as the two arms above, deliberately.
    if (sub.reader_card_action_required_at) {
      await pool
        .query(
          `UPDATE subscriptions
           SET status = 'expired', auto_renew = FALSE, updated_at = now()
           WHERE id = $1 AND status = 'active' AND current_period_end < now()`,
          [sub.id],
        )
        .catch((err) =>
          logger.error(
            { err, subscriptionId: sub.id },
            "Failed to expire subscription whose reader's card has declined",
          ),
        );
      logger.warn(
        {
          subscriptionId: sub.id,
          readerId: sub.reader_id,
          cardActionRequiredSince: sub.reader_card_action_required_at,
        },
        "Subscription expired at renewal — the reader's card terminally declined (not charged)",
      );
      processed++;
      continue;
    }

    // Wave-5 P3 gave this calendar arithmetic; §1.5 gave it an ANCHOR. Advancing
    // the previous end with setUTCMonth normalises an overflow forward (31 Jan
    // + 1mo → 3 Mar) and the next cycle then advances the drifted value, so a
    // subscriber who signed up on the 31st walked forward every month. The
    // period now lands on the subscription's stored anchor day in the target
    // month, clamped to that month's last day: 31 Jan → 28 Feb → 31 Mar.
    const newPeriodStart = sub.current_period_end;
    const newPeriodEnd = advanceSubscriptionPeriod(
      newPeriodStart,
      sub.subscription_period === "annual" ? "annual" : "monthly",
      sub.period_anchor_day,
    );

    // subscription_events.writer_id holds the publication_id for publication
    // subscriptions (mirrors the subscribe path in routes/subscriptions/*).
    const earningTargetId = sub.writer_id ?? sub.publication_id;
    if (!earningTargetId) {
      logger.error(
        { subscriptionId: sub.id },
        "Subscription has neither writer nor publication target; skipping",
      );
      continue;
    }

    // Check if the offer period is expiring — revert to standard price. Offers
    // only attach to writer subscriptions, so writer_standard_price is present
    // whenever offer_periods_remaining is.
    let renewalPrice = sub.price_pence;
    const offerExpiring =
      sub.offer_periods_remaining !== null && sub.offer_periods_remaining <= 1;

    if (offerExpiring && sub.writer_standard_price !== null) {
      const annualDiscountPct = sub.writer_annual_discount_pct ?? 15;
      renewalPrice =
        sub.subscription_period === "annual"
          ? Math.round(
              sub.writer_standard_price * 12 * (1 - annualDiscountPct / 100),
            )
          : sub.writer_standard_price;
    }

    const renewInTransaction = () =>
      withTransaction(async (client) => {
        // Idempotency guard (D4): roll the subscription period FIRST, gated on
        // the period still being due (`current_period_end < now()`). The retry
        // below re-runs this whole transaction on failure; if the first attempt
        // actually committed but the client never saw the ACK (connection drop
        // after COMMIT), the period has already moved into the future, so this
        // UPDATE matches 0 rows and we abort before charging the reader again.
        // Keying on `< now()` (not the exact Date) avoids a timestamptz vs JS
        // millisecond-precision mismatch.
        let rolled;
        if (offerExpiring) {
          rolled = await client.query(
            `UPDATE subscriptions
             SET current_period_start = $1, current_period_end = $2,
                 price_pence = $3, offer_id = NULL, offer_periods_remaining = NULL, updated_at = now()
             WHERE id = $4 AND current_period_end < now()`,
            [newPeriodStart, newPeriodEnd, renewalPrice, sub.id],
          );
        } else if (sub.offer_periods_remaining !== null) {
          rolled = await client.query(
            `UPDATE subscriptions
             SET current_period_start = $1, current_period_end = $2,
                 offer_periods_remaining = offer_periods_remaining - 1, updated_at = now()
             WHERE id = $3 AND current_period_end < now()`,
            [newPeriodStart, newPeriodEnd, sub.id],
          );
        } else {
          rolled = await client.query(
            `UPDATE subscriptions
             SET current_period_start = $1, current_period_end = $2, updated_at = now()
             WHERE id = $3 AND current_period_end < now()`,
            [newPeriodStart, newPeriodEnd, sub.id],
          );
        }

        // 0 rows ⇒ a prior (commit-ambiguous) attempt already renewed this
        // period. No-op: the empty transaction commits, the outer path sends
        // the renewal email exactly once and counts it processed.
        if (rolled.rowCount === 0) {
          logger.warn(
            { subscriptionId: sub.id },
            "Subscription renewal skipped — period already rolled (idempotency guard)",
          );
          return;
        }

        // Period rolled exactly once. Now charge the reader. F1: the charge
        // debits the reading tab (inside logSubscriptionCharge) and is collected
        // by the normal settlement machinery — the free_allowance column (which
        // was never collected) is no longer touched.
        await logSubscriptionCharge(
          client,
          sub.id,
          sub.reader_id,
          sub.writer_id,
          renewalPrice,
          newPeriodStart,
          newPeriodEnd,
          sub.publication_id,
        );

        const renewalEvent = signSubscriptionEvent({
          subscriptionId: sub.id,
          readerPubkey: sub.reader_pubkey,
          writerPubkey: sub.writer_pubkey,
          status: "active",
          pricePence: renewalPrice,
          periodStart: newPeriodStart,
          periodEnd: newPeriodEnd,
        });
        await client.query(
          `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
          [renewalEvent.id, sub.id],
        );
        await enqueueRelayPublish(client, {
          entityType: "subscription",
          entityId: sub.id,
          signedEvent: renewalEvent,
        });
      });

    try {
      // Retry once before giving up — a transient DB blip or a signing hiccup
      // shouldn't permanently kill a paid subscription (spec: retry once, then
      // expire). Safe to re-run: a rolled-back first attempt leaves no partial
      // charge, and a committed-but-unacked first attempt is caught by the
      // `current_period_end < now()` idempotency guard inside the transaction.
      try {
        await renewInTransaction();
      } catch (firstErr) {
        logger.warn(
          { err: firstErr, subscriptionId: sub.id },
          "Subscription renewal failed, retrying once",
        );
        await renewInTransaction();
      }

      // Renewal emails are reader-facing and look up the writer as an account;
      // publication subscriptions have no account writer, so skip them (the
      // email would silently no-op on the null lookup anyway).
      if (sub.writer_id) {
        sendSubscriptionRenewedEmail(
          sub.reader_id,
          sub.writer_id,
          renewalPrice,
          newPeriodEnd,
        ).catch((err) =>
          logger.warn({ err, subscriptionId: sub.id }, "Renewal email failed"),
        );
      }

      logger.info(
        {
          subscriptionId: sub.id,
          readerId: sub.reader_id,
          writerId: sub.writer_id,
          publicationId: sub.publication_id,
        },
        "Subscription renewed",
      );
      processed++;
    } catch (err) {
      // Both attempts failed — expire the subscription.
      logger.error(
        { err, subscriptionId: sub.id },
        "Subscription renewal failed after retry, expiring",
      );
      await pool
        .query(
          `UPDATE subscriptions SET status = 'expired', auto_renew = FALSE, updated_at = now() WHERE id = $1`,
          [sub.id],
        )
        .catch((expErr) =>
          logger.error(
            { err: expErr, subscriptionId: sub.id },
            "Failed to expire after renewal failure",
          ),
        );
      processed++;
    }
  }

  // --- Phase 2: Expire non-renewing subscriptions past period end ---
  const expired = await pool.query(
    `UPDATE subscriptions
     SET status = 'expired', updated_at = now()
     WHERE status IN ('active', 'cancelled')
       AND auto_renew = FALSE
       AND current_period_end < now()
     RETURNING id`,
  );

  const expiredCount = expired.rowCount ?? 0;
  if (expiredCount > 0) {
    logger.info({ count: expiredCount }, "Expired non-renewing subscriptions");
    processed += expiredCount;
  }

  // --- Phase 3: Send expiry warning emails (3 days before period end) ---
  const expiringSoon = await pool.query<{
    id: string;
    reader_id: string;
    writer_id: string | null;
    publication_id: string | null;
    current_period_end: Date;
  }>(
    `SELECT s.id, s.reader_id, s.writer_id, s.publication_id, s.current_period_end
     FROM subscriptions s
     WHERE s.status IN ('active', 'cancelled')
       AND s.auto_renew = FALSE
       AND s.current_period_end BETWEEN now() AND now() + INTERVAL '3 days'
       AND NOT EXISTS (
         SELECT 1 FROM subscription_events se
         WHERE se.subscription_id = s.id
           AND se.event_type = 'expiry_warning_sent'
           AND se.created_at > now() - INTERVAL '4 days'
       )`,
  );

  for (const sub of expiringSoon.rows) {
    // The warning email resolves the writer as an account; publication subs
    // have no account writer, so skip the email (it would no-op on the null
    // lookup) but still record the marker so the warning isn't retried forever.
    if (sub.writer_id) {
      sendSubscriptionExpiryWarningEmail(
        sub.reader_id,
        sub.writer_id,
        sub.current_period_end,
      ).catch((err) =>
        logger.warn(
          { err, subscriptionId: sub.id },
          "Expiry warning email failed",
        ),
      );
    }
    // Await: a missing insert after a successful email send means the next
    // cycle re-sends. subscription_events requires a writer XOR publication
    // target (migration 103).
    await pool.query(
      `INSERT INTO subscription_events (subscription_id, event_type, reader_id, writer_id, publication_id, amount_pence, description)
       VALUES ($1, 'expiry_warning_sent', $2, $3, $4, 0, 'Expiry warning sent')`,
      [sub.id, sub.reader_id, sub.writer_id, sub.publication_id],
    );
  }

  return processed;
}
