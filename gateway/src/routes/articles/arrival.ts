import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import { performGatePass } from "../../services/article-access/index.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// POST /articles/:dTag/arrival — the landing a paywall signup comes back to.
//
// PAYWALL-ARRIVAL-ADR §3, D4, §11.4. Someone who hit a paywall mid-article and
// made an account has told us exactly what they want in the most expensive
// currency a stranger has: attention already spent. This route's only job is to
// not lose that — the piece opens where they stopped reading, and the welcome
// is an aside on top of a win rather than a second toll gate.
//
// IT IS A MONEY PATH WITH NO GESTURE BEHIND IT, WHICH IS WHY IT IS ITS OWN
// ROUTE AND NOT A FLAG ON THE GATE-PASS ONE. Nothing else in the product opens
// a paywalled piece without a press. FOUR server-side conditions bound it. The
// first three are facts about the ACCOUNT, stamped at signup, rather than about
// the page view; the fourth is about the moment of the read, and it is there
// because the first three can all hold and the read still cost something:
//
//   1. `arrival_article_id` must be THIS piece. That is stamped at account
//      creation (migration 188), so it is false for every account that arrived
//      any other way — including the logged-out MEMBER who signs in at the same
//      gate when the beta opens (§11.5). "First authenticated landing" would
//      have fired for them precisely, and collected them a welcome to a site
//      they already live on, over a gift they were never given.
//
//   2. `arrival_gift_pence > 0`. That figure already encodes both halves of the
//      cap — at or below the dial, AND deliverable — because `resolveArrivalGift`
//      is the one place either is decided. Above the cap the piece stays gated
//      and the reader presses the button, exactly as they do today, which is
//      also what the modal tells them.
//
//   3. NO CARD. The read has to cost nothing. A card holder's
//      `allowanceConsumedPence` is 0 (the gift is not revoked by a card), so
//      the same call would be a FULL-PRICE CHARGE FIRED BY A PAGE LOAD. No
//      signup can carry a card today, so this is unreachable — and it is
//      written anyway, because the day card capture is added to signup is the
//      day it becomes reachable, and idempotence is not the answer: a repeat
//      gate pass returns the existing read and so cannot double-charge, but it
//      cannot make a first charge consented to either.
//
//   4. THE ALLOWANCE STILL COVERS THE PIECE — `free_allowance_remaining_pence
//      >= articles.price_pence`, both read NOW, in the same statement as the
//      rest. Conditions 2 and 3 were stamped at account creation; this one
//      cannot be, because the reader can spend the allowance elsewhere between
//      signing up and landing, and the author can reprice the piece in the same
//      window. See the guard's own comment for why holding this bound one
//      service away — on payment-service's `FREE_ALLOWANCE_FLOOR_PENCE` — was
//      the right outcome for the wrong reason.
//
// WHAT IT RETURNS. `arrival: false` for everyone else — no modal, no unlock,
// and no gate pass attempted. Otherwise the welcome's own figures plus, when
// the unlock happened, the same success body `/gate-pass` returns, so the
// client decrypts down its ONE existing path rather than a second copy of it.
//
// The `welcomeGiftPence` it hands back is `granted − arrival` — the dial AS IT
// STOOD FOR THIS READER, not the live one. D2 says render the figure from the
// dial rather than from the post-arrival balance (which equals it only when the
// arrival read was their first); the stamped pair is that same number and
// survives a retune, for the reason migration 169 exists.
// =============================================================================

interface ArrivalRow {
  arrival_article_id: string | null;
  arrival_gift_pence: number;
  free_allowance_granted_pence: number;
  free_allowance_remaining_pence: number;
  has_card: boolean;
  article_id: string | null;
  nostr_event_id: string | null;
  price_pence: number | null;
}

export async function articleArrivalRoutes(app: FastifyInstance) {
  app.post<{ Params: { dTag: string } }>(
    "/articles/:dTag/arrival",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const readerId = req.session!.sub;
      const readerPubkey = req.session!.pubkey;
      const { dTag } = req.params;

      try {
        // One read, so the account facts and the article facts cannot be taken
        // from two different moments. The LEFT JOIN is on the d-tag, not on the
        // stamped id: the two have to be COMPARED, and joining on the stamp
        // would make every landing look like the arrival landing.
        const { rows } = await pool.query<ArrivalRow>(
          `SELECT acc.arrival_article_id,
                  acc.arrival_gift_pence,
                  acc.free_allowance_granted_pence,
                  acc.free_allowance_remaining_pence,
                  (acc.stripe_customer_id IS NOT NULL) AS has_card,
                  art.id            AS article_id,
                  art.nostr_event_id,
                  art.price_pence
           FROM accounts acc
           LEFT JOIN articles art
             ON art.nostr_d_tag = $2
            AND art.deleted_at IS NULL
            AND art.published_at IS NOT NULL
           WHERE acc.id = $1`,
          [readerId, dTag],
        );

        const row = rows[0];
        if (!row) return reply.status(404).send({ error: "Account not found" });

        // Not this reader's arrival — the ordinary case, and the one that keeps
        // a returning member from being welcomed to their own house.
        if (
          row.arrival_article_id === null ||
          row.article_id === null ||
          row.arrival_article_id !== row.article_id
        ) {
          return reply.send({ arrival: false });
        }

        const welcomeGiftPence =
          row.free_allowance_granted_pence - row.arrival_gift_pence;

        // Above the cap, misconfigured, a card at the read, or an allowance
        // that no longer covers the piece: the piece stays gated and the
        // welcome says so. No money moves on a page load.
        //
        // THE FOURTH TEST IS THE ONE THE ROUTE USED TO DELEGATE. Conditions 1–3
        // are facts stamped AT SIGNUP; whether the read actually costs nothing
        // is a fact about NOW, and the two can disagree. `resolveArrivalGift`
        // granted `dial + p` and stamped `p`, so remaining ≥ price held at that
        // instant — but the reader may have spent the allowance on another
        // paywalled piece before landing (the magic-link and Google carriers are
        // both a real window, and D2 has its own test for the arrival read not
        // being the first), and the author may have REPRICED the piece in the
        // same window. Either way `price_pence` can now exceed what is left.
        //
        // Until now nothing here noticed, and the bound was held one service
        // away: `recordGatePass`'s F3 floor refuses a card-less read once
        // `remaining − amount < FREE_ALLOWANCE_FLOOR_PENCE`, which is 0 by
        // default, so the gate pass failed and the route reported "still gated".
        // That is the right OUTCOME arrived at by an accident of somebody else's
        // env var: `FREE_ALLOWANCE_FLOOR_PENCE` is a dial, and a NEGATIVE value
        // (its documented use — letting the counter drift below zero) lifts the
        // refusal and lets a partly chargeable read through, fired by a page
        // load with no gesture behind it. The CLAUDE.md invariant says this
        // route performs a gate pass "only when the read costs the reader
        // NOTHING"; that sentence is now true OF THIS ROUTE rather than of a
        // configuration of payment-service.
        //
        // `>=`, not `>`: consuming the last penny of the allowance on the piece
        // that was given the penny for it is exactly the intended path — the
        // ordinary arrival is `remaining == dial + p` against a price of `p`.
        const coveredByAllowance =
          row.price_pence !== null &&
          row.free_allowance_remaining_pence >= row.price_pence;

        if (row.arrival_gift_pence <= 0 || row.has_card || !coveredByAllowance) {
          return reply.send({
            arrival: true,
            unlocked: false,
            welcomeGiftPence,
            arrivalGiftPence: row.arrival_gift_pence,
            pricePence: row.price_pence,
          });
        }

        const result = await performGatePass({
          readerId,
          readerPubkey,
          nostrEventId: row.nostr_event_id!,
        });

        if (result.kind !== "success") {
          // Every refusal lands here as "still gated". The reader meets the
          // ordinary gate with its ordinary button and its ordinary errors —
          // which is a working page, not a dead end — and the welcome drops the
          // sentence it can no longer keep. Logged because an arrival that
          // cannot open is rare and otherwise silent: it is the one reader we
          // were trying hardest to welcome.
          logger.warn(
            { readerId, dTag, kind: result.kind },
            "Arrival gate pass did not open the piece",
          );
          return reply.send({
            arrival: true,
            unlocked: false,
            welcomeGiftPence,
            arrivalGiftPence: row.arrival_gift_pence,
            pricePence: row.price_pence,
          });
        }

        return reply.send({
          arrival: true,
          unlocked: true,
          welcomeGiftPence,
          arrivalGiftPence: row.arrival_gift_pence,
          pricePence: row.price_pence,
          gatePass: result.body,
        });
      } catch (err) {
        logger.error({ err, readerId, dTag }, "Arrival landing failed");
        return reply.status(500).send({ error: "Internal error" });
      }
    },
  );
}
