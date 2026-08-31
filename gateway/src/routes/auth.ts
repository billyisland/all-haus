import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  signup,
  SignupSchema,
  getAccount,
  updateProfile,
  connectStripeAccount,
  connectPaymentMethod,
} from "@platform-pub/shared/auth/accounts.js";
import {
  USERNAME_RE,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_RULE_MESSAGE,
} from "@platform-pub/shared/auth/username-rule.js";
import {
  createSession,
  destroySession,
  verifySession,
} from "@platform-pub/shared/auth/session.js";
import {
  requestMagicLink,
  verifyMagicLink,
} from "@platform-pub/shared/auth/magic-links.js";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import {
  sendMagicLinkEmail,
  sendEmail,
} from "@platform-pub/shared/lib/email.js";
import { requireAuth, invalidateAuthCache } from "../middleware/auth.js";
import { getAdminIds } from "../middleware/admin.js";
import { CLOSED_BETA, CLOSED_BETA_ERROR } from "../lib/closed-beta.js";
import { generateKeypair, signEvent } from "../lib/key-custody-client.js";
import { republishProfile } from "../lib/discovery-publish.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import Stripe from "stripe";
import logger from "@platform-pub/shared/lib/logger.js";
import { requireEnv } from "@platform-pub/shared/lib/env.js";
import crypto from "crypto";

// =============================================================================
// Auth Routes — mounted on the gateway
//
// POST /auth/signup              — create account — CLOSED (403 closed_beta)
// POST /auth/login               — magic link login (sends email)
// POST /auth/verify              — verify magic link token → set session
// POST /auth/logout              — clear session
// GET  /auth/me                  — current account info (session hydration)
// POST /auth/upgrade-writer      — start Stripe Connect onboarding
// POST /auth/setup-intent        — begin reader card setup (SetupIntent)
// POST /auth/connect-card        — finalise card setup from succeeded SetupIntent
// POST /auth/deactivate          — deactivate account (reversible)
// POST /auth/delete-account      — permanently delete account
// POST /auth/change-email        — request email change (sends verification)
// POST /auth/verify-email-change — verify email change token
// POST /auth/change-username     — change username (30-day cooldown)
// GET  /auth/check-username/:u   — check username availability
// =============================================================================

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2023-10-16",
});

export async function authRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /auth/signup
  // ---------------------------------------------------------------------------

  app.post(
    "/auth/signup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      // CLOSED BETA (CLOSED-BETA-ADR D1) — refuse before parsing, before the
      // keypair, before any insert. The guarantee must hold for a stale
      // frontend or a hand-crafted request, not just for the UI we ship.
      if (CLOSED_BETA) {
        return reply.status(403).send({ error: CLOSED_BETA_ERROR });
      }

      const parsed = SignupSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      try {
        // Generate keypair via key-custody service — gateway never sees ACCOUNT_KEY_HEX
        const keypair = await generateKeypair();
        const result = await signup(parsed.data, reply, keypair);
        return reply.status(201).send(result);
      } catch (err: any) {
        // Unique constraint violations (duplicate username, email, or pubkey)
        if (err.code === "23505") {
          const field = err.constraint?.includes("username")
            ? "username"
            : err.constraint?.includes("email")
              ? "email"
              : "account";
          return reply.status(409).send({ error: `${field}_taken` });
        }
        logger.error({ err }, "Signup failed");
        return reply.status(500).send({ error: "Signup failed" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/login — magic link
  //
  // Passwordless email login: user enters email → one-time link sent →
  // link contains a signed token → POST /auth/verify validates it → session set.
  // ---------------------------------------------------------------------------

  const LoginSchema = z.object({
    email: z.string().email(),
  });

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const result = await requestMagicLink(parsed.data.email);

      if (result) {
        // Send the magic link email
        // In dev (EMAIL_PROVIDER=console), this logs to stdout
        // In production, set EMAIL_PROVIDER=postmark or resend
        try {
          await sendMagicLinkEmail(
            parsed.data.email,
            result.token,
            result.expiresAt,
          );
        } catch (err) {
          logger.error(
            { err, email: parsed.data.email.slice(0, 3) + "***" },
            "Magic link email failed",
          );
          // Don't fail the request — the token is still valid, and we don't
          // want to reveal whether an account exists via email delivery errors
        }
      }

      // Always return the same response — don't reveal whether the account exists
      return reply.status(200).send({
        message:
          "If an account exists with that email, a login link has been sent.",
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/verify — verify magic link token → create session
  // ---------------------------------------------------------------------------

  const VerifySchema = z.object({
    token: z.string().min(1),
  });

  app.post(
    "/auth/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = VerifySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const accountId = await verifyMagicLink(parsed.data.token);
      if (!accountId) {
        return reply
          .status(401)
          .send({ error: "Invalid or expired login link" });
      }

      const account = await getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ error: "Account not found" });
      }

      // Only active/deactivated may mint a session: suspended (admin action)
      // and deleted (terminal, migration 159) must be refused even holding a
      // valid pre-issued link — mirrors the Google OAuth branch.
      if (account.status !== "active" && account.status !== "deactivated") {
        return reply.status(403).send({
          error:
            account.status === "deleted"
              ? "Account deleted"
              : "Account suspended",
        });
      }

      // Reactivate on login — logging back in is the promised reactivation path
      // (POST /auth/deactivate). Only 'deactivated' → 'active'; no-op otherwise.
      if (account.status === "deactivated") {
        await pool.query(
          `UPDATE accounts SET status = 'active', updated_at = now() WHERE id = $1`,
          [account.id],
        );
        invalidateAuthCache(account.id);
        logger.info({ accountId: account.id }, "Account reactivated on login");
      }

      // Create session
      await createSession(reply, {
        id: account.id,
        nostrPubkey: account.nostrPubkey,
      });

      return reply.status(200).send({
        id: account.id,
        username: account.username,
        displayName: account.displayName,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/dev-login — instant login for local development (no magic link)
  // Only available when NODE_ENV=development
  // ---------------------------------------------------------------------------

  if (process.env.NODE_ENV === "development") {
    app.post("/auth/dev-login", async (req, reply) => {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM accounts WHERE email = $1 AND status = $2",
        [parsed.data.email.toLowerCase().trim(), "active"],
      );

      if (rows.length === 0) {
        return reply
          .status(404)
          .send({ error: "No account found with that email" });
      }

      const account = await getAccount(rows[0].id);
      if (!account) {
        return reply.status(404).send({ error: "Account not found" });
      }

      await createSession(reply, {
        id: account.id,
        nostrPubkey: account.nostrPubkey,
      });

      logger.info(
        { email: parsed.data.email, accountId: account.id },
        "Dev login — session created",
      );

      return reply.status(200).send({
        id: account.id,
        username: account.username,
        displayName: account.displayName,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // POST /auth/logout
  // ---------------------------------------------------------------------------

  app.post("/auth/logout", async (req, reply) => {
    // If we have a valid session, invalidate all sessions for this account
    const session = await verifySession(req);
    if (session?.sub) {
      await pool.query(
        "UPDATE accounts SET sessions_invalidated_at = now() WHERE id = $1",
        [session.sub],
      );
      invalidateAuthCache(session.sub);
    }
    destroySession(reply);
    return reply.status(200).send({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // GET /auth/me — session hydration
  // Returns the current user's account info, or 401 if not logged in.
  // The web client calls this on page load to hydrate auth state.
  // ---------------------------------------------------------------------------

  app.get("/auth/me", { preHandler: requireAuth }, async (req, reply) => {
    const account = await getAccount(req.session!.sub);
    if (!account) {
      return reply.status(404).send({ error: "Account not found" });
    }

    // The ONE admin-identity home (middleware/admin.ts): platform_config
    // first, env fallback — the same set requireAdmin checks. A divergent
    // env-only read here meant an admin granted via the dashboard's config
    // editor passed the API guard but /auth/me said isAdmin:false, so
    // AdminShell bounced them to /reader (audit 2026-07-24).
    const adminIds = await getAdminIds();

    return reply.status(200).send({
      id: account.id,
      pubkey: account.nostrPubkey,
      username: account.username,
      displayName: account.displayName,
      bio: account.bio,
      avatar: account.avatarBlossomUrl,
      email: account.email,
      hasPaymentMethod: account.stripeCustomerId !== null,
      // A frozen tab (terminal card decline) is a state the reader must be told
      // about wherever they meet it, not only on the ledger — so it rides the
      // session payload beside hasPaymentMethod rather than being fetched
      // per-surface. Cleared by connectPaymentMethod. STRIPE audit S1.
      cardActionRequiredAt: account.cardActionRequiredAt,
      stripeConnectKycComplete: account.stripeConnectKycComplete,
      freeAllowanceRemainingPence: account.freeAllowanceRemainingPence,
      defaultArticlePricePence: account.defaultArticlePricePence,
      isAdmin: adminIds.includes(account.id),
      usernameChangedAt: account.usernameChangedAt,
      // NULL ⇒ the first-session welcome has never been offered to this member
      // (migration 176). Rides the session payload for the same reason
      // `cardActionRequiredAt` does: the workspace already has it at bootstrap,
      // so gating the sheet costs no extra round trip. Device-independent by
      // construction — the two older seen-flags are `localStorage` and would ask
      // a member to introduce themselves again on every new browser.
      onboardedAt: account.onboardedAt,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /auth/onboarded — record that the first-session welcome was answered
  //
  // Answered, NOT completed: dismissing the sheet is an answer, and a member who
  // closes it must not be asked again on their next device. So both the "Done"
  // path and the ✕ call this. Nothing about the profile is inferred from it.
  //
  // FIRST-WRITE-WINS via `WHERE onboarded_at IS NULL`, mirroring the halt
  // table's arbiter: the timestamp records when the offer was first answered,
  // and a duplicate call (two tabs, a retry after a flaky response) must not
  // move it. That also makes the route idempotent, which is what lets the client
  // fire it without awaiting — a lost call costs one repeat offer, never an
  // error the member has to see.
  // ---------------------------------------------------------------------------

  app.post("/auth/onboarded", { preHandler: requireAuth }, async (req, reply) => {
    await pool.query(
      `UPDATE accounts SET onboarded_at = now()
        WHERE id = $1 AND onboarded_at IS NULL`,
      [req.session!.sub],
    );
    // Always 200, whether or not this call was the one that stamped it — the
    // caller's question is "is this member welcomed", and after either outcome
    // the answer is yes. Reporting the rowCount would invite a client to treat
    // 0 as a failure and retry a settled state.
    invalidateAuthCache(req.session!.sub);
    return reply.status(200).send({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // PATCH /auth/profile — update display name, bio, avatar
  // ---------------------------------------------------------------------------

  const UpdateProfileSchema = z.object({
    displayName: z.string().min(1).max(100).optional(),
    bio: z.string().max(500).optional(),
    avatar: z.string().url().max(500).nullable().optional(),
  });

  app.patch(
    "/auth/profile",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = UpdateProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const accountId = req.session!.sub;

      await updateProfile(accountId, {
        displayName: parsed.data.displayName,
        bio: parsed.data.bio,
        avatarBlossomUrl:
          parsed.data.avatar === null ? null : parsed.data.avatar,
      });

      // Republish kind-0 profile metadata to the Nostr mesh (no-op when
      // discovery is disabled). Fire-and-forget — never block the response.
      republishProfile(accountId).catch((err) =>
        logger.warn({ err, accountId }, "Failed to republish profile (kind 0)"));

      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/upgrade-writer — start Stripe Connect onboarding
  //
  // Creates a Stripe Connect Express account and returns the onboarding URL.
  // The writer is redirected to Stripe's hosted onboarding flow. When KYC
  // completes, the account.updated webhook (already handled by payment-service)
  // marks stripe_connect_kyc_complete = true.
  // ---------------------------------------------------------------------------

  app.post(
    "/auth/upgrade-writer",
    { preHandler: requireAuth },
    async (req, reply) => {
      const accountId = req.session!.sub;
      const account = await getAccount(accountId);

      if (!account) {
        return reply.status(404).send({ error: "Account not found" });
      }

      if (account.stripeConnectId) {
        return reply.status(409).send({ error: "Stripe already connected" });
      }

      try {
        // Create Stripe Connect Express account
        const connectAccount = await stripe.accounts.create({
          type: "express",
          country: "GB",
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: {
            platform: "all.haus",
            account_id: accountId,
          },
        });

        // Generate onboarding link.
        //
        // Both URLs must be routes that EXIST. They pointed at
        // `/settings/payments` until 2026-07-30, which has never existed since
        // settings became a workspace overlay — `web/src/app/settings/` holds a
        // single `page.tsx`, itself a shim — so every writer who completed
        // Stripe KYC was returned to a 404, and so was every writer whose link
        // expired. Nothing in the app reads either query param; they are
        // breadcrumbs, forwarded by the shim for logs and future use.
        //
        // Via `/settings` rather than straight to `/reader?overlay=settings`,
        // matching the OAuth callback's `?linked=` precedent: the shim is the
        // compatibility surface for an EXTERNAL service returning the browser to
        // us, and one convention for that is worth a redirect hop. Connect
        // status is rendered by `account/PaymentSection` inside that panel, and
        // a return from Stripe is a full page load, so `fetchMe()` runs fresh —
        // no explicit refetch needed.
        const accountLink = await stripe.accountLinks.create({
          account: connectAccount.id,
          refresh_url: `${process.env.APP_URL}/settings?refresh=true`,
          return_url: `${process.env.APP_URL}/settings?onboarding=complete`,
          type: "account_onboarding",
        });

        const result = await connectStripeAccount(
          accountId,
          connectAccount.id,
          accountLink.url,
        );

        return reply.status(200).send(result);
      } catch (err) {
        logger.error({ err, accountId }, "Writer upgrade failed");
        return reply
          .status(500)
          .send({ error: "Failed to start Stripe onboarding" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/connect-card — set up reader payment method
  //
  // Called after Stripe Elements completes card setup on the client.
  // Creates a Stripe Customer (if needed), attaches the payment method,
  // and records the customer ID on the account.
  //
  // This also triggers conversion of provisional reads to accrued
  // (via the payment service's /card-connected endpoint).
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // POST /auth/setup-intent — begin card setup.
  //
  // Creates (or reuses) the reader's Stripe Customer and returns a SetupIntent
  // client_secret. The client confirms it with Stripe.js, handling any 3DS/SCA
  // step inline while the reader is present — which validates the card AND
  // authorises future OFF-SESSION charges, the exact usage tab settlement
  // relies on. The card is only recorded once the SetupIntent SUCCEEDS, in
  // /auth/connect-card. STRIPE audit S2 (was: blind paymentMethods.attach with
  // no server-side validation, so a bad/expired/3DS-mandatory card attached
  // cleanly and only failed weeks later at the first settlement — S1).
  //
  // We do NOT persist a freshly-created customer here: stripe_customer_id is
  // the "reader has a usable card" signal (auth/me hasPaymentMethod, votes
  // hasCard, settlement's attempt gate), so it must flip true only on a
  // confirmed card. A customer for an abandoned setup is a harmless orphan; on
  // confirm we read the customer straight off the succeeded SetupIntent.
  // ---------------------------------------------------------------------------

  app.post(
    "/auth/setup-intent",
    { preHandler: requireAuth },
    async (req, reply) => {
      const accountId = req.session!.sub;
      const account = await getAccount(accountId);

      if (!account) {
        return reply.status(404).send({ error: "Account not found" });
      }

      try {
        let customerId = account.stripeCustomerId;

        if (!customerId) {
          const customer = await stripe.customers.create({
            metadata: { platform: "all.haus", account_id: accountId },
          });
          customerId = customer.id;
        }

        const setupIntent = await stripe.setupIntents.create({
          customer: customerId,
          payment_method_types: ["card"],
          usage: "off_session",
          metadata: { platform: "all.haus", account_id: accountId },
        });

        return reply
          .status(200)
          .send({ clientSecret: setupIntent.client_secret });
      } catch (err) {
        logger.error({ err, accountId }, "Failed to create setup intent");
        return reply.status(500).send({ error: "Failed to start card setup" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/connect-card — finalise card setup from a succeeded SetupIntent.
  //
  // The client has confirmed the SetupIntent (minted by /auth/setup-intent)
  // with Stripe.js. We retrieve it, assert it SUCCEEDED and belongs to this
  // account, set its now-validated payment method as the customer default, and
  // record the customer — flipping the reader to "has a card". Replaces the old
  // blind attach of a client-supplied paymentMethodId. STRIPE audit S2.
  //
  // Also triggers conversion of provisional reads to accrued via the payment
  // service's /card-connected endpoint.
  // ---------------------------------------------------------------------------

  const ConnectCardSchema = z.object({
    setupIntentId: z.string().min(1),
  });

  app.post(
    "/auth/connect-card",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ConnectCardSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const accountId = req.session!.sub;
      const account = await getAccount(accountId);

      if (!account) {
        return reply.status(404).send({ error: "Account not found" });
      }

      try {
        const setupIntent = await stripe.setupIntents.retrieve(
          parsed.data.setupIntentId,
        );

        // Never trust a client-supplied id blindly: the SetupIntent must carry
        // this account's id in the metadata we stamped at creation.
        if (setupIntent.metadata?.account_id !== accountId) {
          logger.warn(
            { accountId, setupIntentId: parsed.data.setupIntentId },
            "connect-card: SetupIntent does not belong to this account",
          );
          return reply.status(403).send({ error: "Invalid setup intent" });
        }

        if (setupIntent.status !== "succeeded") {
          logger.warn(
            { accountId, status: setupIntent.status },
            "connect-card: SetupIntent not succeeded — card not usable",
          );
          return reply
            .status(400)
            .send({ error: "Card setup did not complete. Please try again." });
        }

        const customerId =
          typeof setupIntent.customer === "string"
            ? setupIntent.customer
            : (setupIntent.customer?.id ?? null);
        const paymentMethodId =
          typeof setupIntent.payment_method === "string"
            ? setupIntent.payment_method
            : (setupIntent.payment_method?.id ?? null);

        if (!customerId || !paymentMethodId) {
          logger.error(
            { accountId, setupIntentId: setupIntent.id },
            "connect-card: succeeded SetupIntent missing customer or payment_method",
          );
          return reply
            .status(500)
            .send({ error: "Failed to connect payment method" });
        }

        // Confirming the SetupIntent already attached the PM to the customer;
        // just make it the default for future off-session settlement charges.
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });

        // Record on account (also clears any settlement back-off flag — S1).
        await connectPaymentMethod(accountId, customerId);

        // Notify payment service to convert provisional reads
        // This is a fire-and-forget internal call — failure is logged, not fatal
        try {
          const paymentServiceUrl =
            process.env.PAYMENT_SERVICE_URL ?? "http://localhost:3001";
          await fetch(`${paymentServiceUrl}/api/v1/card-connected`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Token": process.env.INTERNAL_SERVICE_TOKEN ?? "",
            },
            body: JSON.stringify({
              readerId: accountId,
              stripeCustomerId: customerId,
            }),
          });
        } catch (err) {
          logger.error(
            { err, accountId },
            "Failed to notify payment service of card connection",
          );
        }

        return reply.status(200).send({ ok: true, hasPaymentMethod: true });
      } catch (err) {
        logger.error({ err, accountId }, "Card connection failed");
        return reply
          .status(500)
          .send({ error: "Failed to connect payment method" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/deactivate — deactivate account (reversible)
  //
  // Sets account status to 'deactivated' and destroys the session.
  // The user can reactivate by logging back in (magic link still works
  // for deactivated accounts — the verify route should handle reactivation).
  // ---------------------------------------------------------------------------

  app.post(
    "/auth/deactivate",
    { preHandler: requireAuth },
    async (req, reply) => {
      const accountId = req.session!.sub;

      await pool.query(
        `UPDATE accounts SET status = 'deactivated', updated_at = now() WHERE id = $1`,
        [accountId],
      );
      invalidateAuthCache(accountId);

      logger.info({ accountId }, "Account deactivated");
      destroySession(reply);
      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/delete-account — permanently delete account
  //
  // Requires the user to confirm by submitting their email address.
  // Cancels subscriptions, soft-deletes articles and hard-deletes notes
  // (both with kind-5 events), and soft-deletes the account row.
  // ---------------------------------------------------------------------------

  const DeleteAccountSchema = z.object({
    emailConfirmation: z.string().email(),
  });

  app.post(
    "/auth/delete-account",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = DeleteAccountSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const accountId = req.session!.sub;

      // Verify the email matches
      const { rows: accountRows } = await pool.query<{
        email: string;
        nostr_pubkey: string;
      }>(
        "SELECT email, nostr_pubkey FROM accounts WHERE id = $1",
        [accountId],
      );
      if (accountRows.length === 0) {
        return reply.status(404).send({ error: "Account not found" });
      }
      if (
        accountRows[0].email.toLowerCase() !==
        parsed.data.emailConfirmation.toLowerCase()
      ) {
        return reply.status(400).send({ error: "Email does not match" });
      }

      await withTransaction(async (client) => {
        // Cancel all active subscriptions (as reader)
        await client.query(
          `UPDATE subscriptions SET status = 'cancelled', cancelled_at = now()
         WHERE reader_id = $1 AND status = 'active'`,
          [accountId],
        );

        // Cancel all active subscriptions (as writer — subscribers lose access)
        await client.query(
          `UPDATE subscriptions SET status = 'cancelled', cancelled_at = now()
         WHERE writer_id = $1 AND status = 'active'`,
          [accountId],
        );

        // Soft-delete all articles and collect event IDs for kind-5 deletion
        const { rows: articles } = await client.query<{
          id: string;
          nostr_event_id: string;
          nostr_d_tag: string;
        }>(
          `UPDATE articles SET deleted_at = now()
         WHERE writer_id = $1 AND deleted_at IS NULL
         RETURNING id, nostr_event_id, nostr_d_tag`,
          [accountId],
        );

        // Clear the articles' feed cards in the same transaction. Feed reads
        // filter fi.deleted_at only (no account-status predicate), so without
        // this the deleted account's cards linger in every feed until the
        // daily reconcile (§0k.1). Soft-stamp, matching the article
        // soft-delete idiom (DELETE /articles/:id in manage.ts); the notes'
        // feed_items go with the notes hard-DELETE below via FK cascade.
        await client.query(
          `UPDATE feed_items SET deleted_at = now()
           WHERE article_id IN (SELECT id FROM articles WHERE writer_id = $1)
             AND deleted_at IS NULL`,
          [accountId],
        );

        // Enqueue kind 5 deletion events (non-fatal — DB is source of truth).
        // relay_outbox owns retry so a relay blip during account deletion no
        // longer leaves tombstones un-published.
        for (const article of articles) {
          try {
            const deletionEvent = await signEvent(accountId, {
              kind: 5,
              content: "",
              tags: [
                ["e", article.nostr_event_id],
                [
                  "a",
                  `30023:${accountRows[0].nostr_pubkey}:${article.nostr_d_tag}`,
                ],
              ],
              created_at: Math.floor(Date.now() / 1000),
            });
            await enqueueRelayPublish(client, {
              entityType: "article_deletion",
              entityId: article.id,
              signedEvent: deletionEvent as SignedNostrEvent,
            });
          } catch (err) {
            logger.error(
              { err, articleId: article.id },
              "Failed to enqueue kind 5 deletion event during account deletion",
            );
          }
        }

        // Hard-delete all notes and enqueue kind-5 tombstones — notes has no
        // soft-delete column, so this matches DELETE /notes/:nostrEventId
        // (feed_items/notifications FKs cascade).
        const { rows: notes } = await client.query<{
          id: string;
          nostr_event_id: string;
        }>(
          `DELETE FROM notes
           WHERE author_id = $1
           RETURNING id, nostr_event_id`,
          [accountId],
        );

        for (const note of notes) {
          try {
            const deletionEvent = await signEvent(accountId, {
              kind: 5,
              content: "",
              tags: [["e", note.nostr_event_id]],
              created_at: Math.floor(Date.now() / 1000),
            });
            await enqueueRelayPublish(client, {
              entityType: "note_deletion",
              entityId: note.id,
              signedEvent: deletionEvent as SignedNostrEvent,
            });
          } catch (err) {
            logger.error(
              { err, noteId: note.id },
              "Failed to enqueue kind 5 deletion event for note during account deletion",
            );
          }
        }

        // Soft-delete the account — hard-delete would violate ON DELETE RESTRICT
        // FKs on articles, read_events, vote_charges, unlock_records, etc.
        // Clean up relations that won't be useful post-deletion.
        await client.query(
          "DELETE FROM follows WHERE follower_id = $1 OR followee_id = $1",
          [accountId],
        );
        await client.query("DELETE FROM bookmarks WHERE user_id = $1", [
          accountId,
        ]);
        // feed_saves is feed-scoped (no user column) — clear via the owner's feeds
        await client.query(
          `DELETE FROM feed_saves
           WHERE feed_id IN (SELECT id FROM feeds WHERE owner_id = $1)`,
          [accountId],
        );
        await client.query(
          `UPDATE accounts
           SET status = 'deleted', email = 'deleted-' || id || '@deleted',
               display_name = NULL, bio = NULL, avatar_blossom_url = NULL,
               sessions_invalidated_at = now(), updated_at = now()
           WHERE id = $1`,
          [accountId],
        );

        logger.info(
          {
            accountId,
            articlesDeleted: articles.length,
            notesDeleted: notes.length,
          },
          "Account soft-deleted",
        );
      });

      // Every accounts.status / sessions_invalidated_at writer invalidates the
      // auth cache post-commit — this one was missed (2026-07-06 audit), so a
      // second device kept authenticating for a TTL after deletion.
      invalidateAuthCache(accountId);

      destroySession(reply);
      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/change-email — request email change
  //
  // Stores the new email in pending_email with a verification token.
  // Sends a verification link to the new address. The current email
  // remains active until the verification link is clicked.
  // ---------------------------------------------------------------------------

  const ChangeEmailSchema = z.object({
    newEmail: z.string().email(),
  });

  app.post(
    "/auth/change-email",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ChangeEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const accountId = req.session!.sub;
      const newEmail = parsed.data.newEmail.toLowerCase().trim();

      // Check if email is already in use — return success either way to
      // prevent email enumeration. If taken, skip the DB write + email.
      const { rows: existing } = await pool.query(
        "SELECT id FROM accounts WHERE email = $1 AND id != $2",
        [newEmail, accountId],
      );
      if (existing.length > 0) {
        return reply
          .status(200)
          .send({ ok: true, message: "Verification email sent" });
      }

      // Generate verification token
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      await pool.query(
        `UPDATE accounts SET pending_email = $1, email_verification_token = $2,
         email_verification_requested_at = now(), updated_at = now()
       WHERE id = $3`,
        [newEmail, tokenHash, accountId],
      );

      // Send verification email to the new address
      const appUrl = process.env.APP_URL ?? "http://localhost:3010";
      const verifyUrl = `${appUrl}/auth/verify?emailChange=${encodeURIComponent(token)}`;

      try {
        await sendEmail({
          to: newEmail,
          subject: "Verify your new email — all.haus",
          textBody: [
            "Click this link to verify your new email address on all.haus:",
            "",
            verifyUrl,
            "",
            "If you didn't request this change, you can ignore this email.",
          ].join("\n"),
          htmlBody: `
          <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
            <h2 style="font-size: 20px; font-weight: 600; color: #1c1917; margin-bottom: 16px;">
              Verify your new email
            </h2>
            <p style="font-size: 15px; color: #57534e; line-height: 1.6; margin-bottom: 24px;">
              Click the button below to confirm this as your new email address on all.haus.
            </p>
            <a href="${verifyUrl}"
               style="display: inline-block; background: #1c1917; color: #ffffff; font-size: 14px; font-weight: 500; padding: 12px 28px; text-decoration: none;">
              Verify email
            </a>
            <p style="font-size: 13px; color: #a8a29e; margin-top: 32px; line-height: 1.5;">
              If you didn't request this change, you can safely ignore this email.
            </p>
          </div>`,
        });
      } catch (err) {
        logger.error(
          { err, accountId },
          "Failed to send email change verification",
        );
        return reply
          .status(500)
          .send({ error: "Failed to send verification email" });
      }

      logger.info(
        { accountId, newEmail: newEmail.slice(0, 3) + "***" },
        "Email change requested",
      );
      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/verify-email-change — verify email change token
  //
  // Swaps the pending email into the email field and clears the pending fields.
  // ---------------------------------------------------------------------------

  const VerifyEmailChangeSchema = z.object({
    token: z.string().min(1),
  });

  app.post(
    "/auth/verify-email-change",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = VerifyEmailChangeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const tokenHash = crypto
        .createHash("sha256")
        .update(parsed.data.token)
        .digest("hex");

      const { rows } = await pool.query<{
        id: string;
        pending_email: string;
        email_verification_requested_at: Date | null;
      }>(
        `SELECT id, pending_email, email_verification_requested_at FROM accounts
       WHERE email_verification_token = $1 AND pending_email IS NOT NULL`,
        [tokenHash],
      );

      if (rows.length === 0) {
        return reply
          .status(400)
          .send({ error: "Invalid or expired verification token" });
      }

      const { id: accountId, pending_email: newEmail } = rows[0];

      // 24-hour TTL
      const requestedAt = rows[0].email_verification_requested_at;
      if (
        requestedAt &&
        Date.now() - requestedAt.getTime() > 24 * 60 * 60 * 1000
      ) {
        await pool.query(
          `UPDATE accounts SET pending_email = NULL, email_verification_token = NULL WHERE id = $1`,
          [accountId],
        );
        return reply
          .status(400)
          .send({ error: "Invalid or expired verification token" });
      }

      // Check the new email hasn't been taken since the request was made
      const { rows: conflict } = await pool.query(
        "SELECT id FROM accounts WHERE email = $1 AND id != $2",
        [newEmail, accountId],
      );
      if (conflict.length > 0) {
        await pool.query(
          `UPDATE accounts SET pending_email = NULL, email_verification_token = NULL WHERE id = $1`,
          [accountId],
        );
        return reply
          .status(409)
          .send({ error: "Email change could not be completed" });
      }

      await pool.query(
        `UPDATE accounts SET email = $1, pending_email = NULL, email_verification_token = NULL, updated_at = now()
       WHERE id = $2`,
        [newEmail, accountId],
      );

      logger.info({ accountId }, "Email changed successfully");
      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/change-username — change username (30-day cooldown)
  //
  // Validates format, checks availability, enforces 30-day cooldown,
  // and sets up a 90-day redirect from the old username.
  // ---------------------------------------------------------------------------

  // USERNAME_RE / the length bounds / the message are imported, not restated —
  // this route is the authority on what a handle may be, and `deriveUsername`
  // has to mint inside it. They had drifted (see the rule's home in
  // shared/auth/accounts.ts).
  const ChangeUsernameSchema = z.object({
    newUsername: z
      .string()
      .min(USERNAME_MIN_LENGTH)
      .max(USERNAME_MAX_LENGTH),
  });

  app.post(
    "/auth/change-username",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ChangeUsernameSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const accountId = req.session!.sub;
      const newUsername = parsed.data.newUsername.toLowerCase();

      if (!USERNAME_RE.test(newUsername)) {
        return reply.status(400).send({ error: USERNAME_RULE_MESSAGE });
      }

      const { rows: account } = await pool.query<{
        username: string | null;
        username_changed_at: Date | null;
      }>("SELECT username, username_changed_at FROM accounts WHERE id = $1", [
        accountId,
      ]);

      if (account.length === 0) {
        return reply.status(404).send({ error: "Account not found" });
      }

      // 30-day cooldown
      if (account[0].username_changed_at) {
        const daysSince =
          (Date.now() - account[0].username_changed_at.getTime()) /
          (1000 * 60 * 60 * 24);
        if (daysSince < 30) {
          const nextChangeDate = new Date(
            account[0].username_changed_at.getTime() + 30 * 24 * 60 * 60 * 1000,
          );
          return reply.status(429).send({
            error: "Username change cooldown active",
            nextChangeDate: nextChangeDate.toISOString(),
          });
        }
      }

      // Check availability
      const { rows: existing } = await pool.query(
        "SELECT id FROM accounts WHERE username = $1 AND id != $2",
        [newUsername, accountId],
      );
      if (existing.length > 0) {
        return reply.status(409).send({ error: "Username already taken" });
      }

      const oldUsername = account[0].username;

      await pool.query(
        `UPDATE accounts
       SET username = $1,
           previous_username = $2,
           username_redirect_until = now() + INTERVAL '90 days',
           username_changed_at = now(),
           updated_at = now()
       WHERE id = $3`,
        [newUsername, oldUsername, accountId],
      );

      // Username drives the kind-0 nip05 field — republish so the NIP-05
      // identifier on the mesh follows the change (no-op when disabled).
      republishProfile(accountId).catch((err) =>
        logger.warn({ err, accountId }, "Failed to republish profile after username change"));

      logger.info({ accountId, oldUsername, newUsername }, "Username changed");
      return reply.status(200).send({ ok: true, username: newUsername });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /auth/check-username/:username — check username availability
  // ---------------------------------------------------------------------------

  app.get<{ Params: { username: string } }>(
    "/auth/check-username/:username",
    { preHandler: requireAuth },
    async (req, reply) => {
      const username = req.params.username.toLowerCase();

      if (!USERNAME_RE.test(username)) {
        return reply
          .status(200)
          .send({ available: false, reason: "Invalid format" });
      }

      const accountId = req.session!.sub;
      const { rows } = await pool.query(
        "SELECT id FROM accounts WHERE username = $1 AND id != $2",
        [username, accountId],
      );

      return reply.status(200).send({ available: rows.length === 0 });
    },
  );
}
