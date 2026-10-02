import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  signup,
  signupSchema,
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
  isReservedUsername,
  USERNAME_RESERVED_MESSAGE,
} from "@platform-pub/shared/auth/reserved-usernames.js";
import {
  createSession,
  destroySession,
  verifySession,
} from "@platform-pub/shared/auth/session.js";
import { accountRateLimitKey } from "../lib/rate-limit-keys.js";
import {
  requestMagicLink,
  verifyMagicLink,
  requestStepUpToken,
  claimStepUpToken,
} from "@platform-pub/shared/auth/magic-links.js";
import { emailChangeExportHoldDays } from "../lib/email-change-hold.js";
import { isUuid } from "../lib/request-inputs.js";
import {
  pool,
  withTransaction,
  loadConfig,
} from "@platform-pub/shared/db/client.js";
import {
  sendMagicLinkEmail,
  sendEmail,
} from "@platform-pub/shared/lib/email.js";
import { renderEmail } from "@platform-pub/shared/lib/email/layout.js";
import {
  emailChangeVerificationEmail,
  emailChangedNoticeEmail,
} from "@platform-pub/shared/lib/email/templates/auth.js";
import { dateOfBirthSchema } from "@platform-pub/shared/lib/age.js";
import { requireAuth, invalidateAuthCache } from "../middleware/auth.js";
import {
  holdsWriterLedger,
  pendingWriterApplication,
  writerAccessRefusal,
} from "../lib/writer-gate.js";
import { requestSettlement } from "../lib/settlement-client.js";
import { notifyCardConnected } from "../lib/card-connected-client.js";
import { getAdminIds } from "../middleware/admin.js";
import { CLOSED_BETA, CLOSED_BETA_ERROR } from "../lib/closed-beta.js";
import { generateKeypair, signEvent, signEvents } from "../lib/key-custody-client.js";
import { republishProfile } from "../lib/discovery-publish.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import Stripe from "stripe";
import logger from "@platform-pub/shared/lib/logger.js";
import { requireEnv } from "@platform-pub/shared/lib/env.js";
import crypto from "crypto";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import {
  TERMS_KINDS,
  currentTermsVersion,
  termsAcceptanceIsCurrent,
  type TermsKind,
} from "@platform-pub/shared/lib/terms-versions.js";

// =============================================================================
// Auth Routes — mounted on the gateway
//
// GET  /auth/open                — is account creation open? (200/404 probe)
// POST /auth/signup              — create account — CLOSED (403 closed_beta)
// POST /auth/login               — magic link login (sends email)
// POST /auth/verify              — verify magic link token → set session
// POST /auth/logout              — clear session
// GET  /auth/me                  — current account info (session hydration)
// POST /auth/upgrade-writer      — start Stripe Connect onboarding
// POST /auth/setup-intent        — begin reader card setup (SetupIntent)
// POST /auth/connect-card        — finalise card setup from succeeded SetupIntent
// POST /auth/accept-terms        — record acceptance of a legal text
// POST /auth/declare-age         — record a declared date of birth
// POST /auth/deactivate          — deactivate account (reversible)
// POST /auth/delete-account      — permanently delete account
// POST /auth/change-email        — request email change (sends verification)
// POST /auth/verify-email-change — verify email change token
// POST /auth/undo-email-change   — the old address undoes a change (no session)
// POST /auth/change-username     — change username (30-day cooldown)
// GET  /auth/check-username/:u   — check username availability
// =============================================================================

// `reader@example.com` → `r***@example.com`, for the notice to an address a
// change replaced: enough for the owner to recognise their own new address,
// not enough to hand a former address's next holder someone's new one.
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2023-10-16",
});

// The money-route bucket, keyed on the authenticated account
// (lib/rate-limit-keys.ts says why an account and not an IP).
const accountMoneyRateLimitKey = accountRateLimitKey("acctmoney");

// THE AGE REFUSAL IS THE MEMBER'S SENTENCE, NOT A VALIDATION DUMP (L6.1).
//
// The rule lives in the SCHEMA, because three doors write `date_of_birth` and
// a check placed at one of them is silently absent from the other two. But
// `zodValidationError`'s `message` is prefixed with the FIELD NAME — a member
// refused at the age gate read `dateOfBirth: You have to be 18 or over to have
// an all.haus account.`, on a blocking surface with no way past it. (Found by
// rendering it; it compiled, linted, built and passed every test.)
//
// So where the ONLY thing wrong with the body is the date of birth, the
// refusal answers under its own code carrying the schema's own sentence. A
// body that is also missing an email is an ordinary validation failure and is
// left alone — the age refusal is the one that has to be readable, because it
// is the one that is about the person rather than about what they typed.
//
// Its own code, and not just nicer copy: the web has to be able to RECOGNISE
// it, and a string crossing this boundary is a claim about a server that
// nothing else checks (`web/tests/age-gate-wire.test.ts`).
export const AGE_DECLARATION_REFUSED = "age_declaration_refused";

function ageRefusal(err: z.ZodError): { error: string; message: string } | null {
  const fields = err.flatten().fieldErrors;
  const keys = Object.keys(fields);
  if (keys.length !== 1 || keys[0] !== "dateOfBirth") return null;
  const message = fields.dateOfBirth?.[0];
  if (!message) return null;
  return { error: AGE_DECLARATION_REFUSED, message };
}

export async function authRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /auth/open — the probe the paywall gate reads
  //
  // The logged-out paywall has two entirely different things to say depending
  // on whether an account can be made (PAYWALL-ARRIVAL D3/§11.6 vs the
  // closed-beta waiting list), and the web must therefore KNOW. It asks rather
  // than carrying a second copy of the flag: reaching this route IS the proof,
  // so there is no second value to drift, and 200/404 is the same
  // terminal-vs-ambiguous split the Stripe classifiers and the internal-parity
  // probe use — anything else is treated as dark for that render and cached as
  // nothing, so a blip cannot switch the offer off for the session.
  //
  // Deliberately not a boolean in a 200 body: a body has to be parsed, and a
  // parse failure would need its own third answer. The status IS the answer.
  // ---------------------------------------------------------------------------

  // Rate-limited like its siblings. It is unauthenticated by necessity — the
  // logged-out gate is the only caller — and cheap (`loadConfig` is cached for
  // 30s, so the open branch is a constant), but "cheap" is a reason for a
  // generous ceiling rather than for none: every other unauthenticated route on
  // this file carries one, and a probe with no bound is the one an idle script
  // finds first. 30/min because a session probes once and caches the answer.
  app.get(
    "/auth/open",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (_req, reply) => {
    if (CLOSED_BETA) {
      return reply.status(404).send({ error: CLOSED_BETA_ERROR });
    }
    // BOTH dials ride the 200, because the gate needs each for a DIFFERENT
    // sentence and neither can be inferred from the other.
    //
    // `freeAllowancePence` is the figure the copy NAMES ("make an account and
    // this one's on the haus — plus £5 of reading"). `arrivalGiftCapPence` is
    // what the gate TESTS this piece's price against to decide whether it may
    // promise the piece is free at all. They were one number until 2026-09-06,
    // and splitting them is the operator's call on arrival amplification (see
    // `resolveArrivalGift`'s rule 2) — but the split is exactly where a gate
    // still testing against the allowance would promise "on the haus" for a
    // piece the server then refuses, silently, on the one surface built to
    // convert a stranger. A figure typed into either sentence would be a second
    // copy of a dial; both are read at request time from the one home, so
    // retuning either retunes the gate in the same move.
    const { freeAllowancePence, arrivalGiftCapPence } = await loadConfig();
    return reply
      .status(200)
      .send({ open: true, freeAllowancePence, arrivalGiftCapPence });
    },
  );

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

      // The schema is BUILT PER REQUEST because the age rule needs a clock
      // (`shared/src/lib/age.ts`): a schema frozen at module load would go on
      // refusing somebody who turned 18 while this process was up.
      const parsed = signupSchema(new Date()).safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(ageRefusal(parsed.error) ?? zodValidationError(parsed.error));
      }

      try {
        // Generate keypair via key-custody service — gateway never sees ACCOUNT_KEY_HEX
        const keypair = await generateKeypair();
        const result = await signup(parsed.data, reply, keypair);
        return reply.status(201).send(result);
      } catch (err: any) {
        // Unique constraint violations (duplicate username, email, or pubkey)
        if (err.code === "23505") {
          // `username` is DERIVED now (PAYWALL-ARRIVAL D9), so a collision on it
          // is our advisory-uniqueness check losing a race, not something the
          // reader typed — it is retryable and must not be reported to them as
          // a field they got wrong. Email is still theirs to fix.
          const field = err.constraint?.includes("email") ? "email" : "account";
          return reply.status(409).send({ error: `${field}_taken` });
        }
        logger.error({ err }, "Signup failed");
        return reply.status(500).send({ error: "Couldn't create your account. Please try again." });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/login — magic link
  //
  // Passwordless email login: user enters email → one-time link sent →
  // link contains a signed token → POST /auth/verify validates it → session set.
  // ---------------------------------------------------------------------------

  // `arrivalDTag` rides the emailed URL — the only carrier that survives the
  // reader opening the link on a different device (PAYWALL-ARRIVAL §5). It is
  // an IDENTIFIER, never a path: the terminus reconstructs `/article/<dTag>`
  // from a value it has validated rather than navigating to a string it was
  // handed, which is what keeps this off the classic open-redirect shape.
  //
  // WHO THIS CARRIES IS NOT WHO §5's TABLE FIRST SAID (§11.7). Magic link
  // creates nothing — `requestMagicLink` issues a token only for an existing
  // account — so this arm carries SIGN-IN intent, for the logged-out MEMBER who
  // meets the gate. They should still land on the piece they came for. They get
  // no gift and no welcome: both are gated on `arrival_article_id`, which is a
  // fact recorded at account creation and therefore false for everyone who was
  // already a member.
  //
  // `surface` is the same kind of value: which verify page the emailed link
  // opens, as a closed enum and never a path. `'modernhaus'` is the no-script
  // register, whose verify page must not consume the token on a GET
  // (MODERNHAUS-ADR §D1.8.1). Absent is the full site.
  const LoginSchema = z.object({
    email: z.string().email(),
    arrivalDTag: z.string().min(1).max(200).optional(),
    surface: z.enum(["modernhaus"]).optional(),
  });

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
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
            parsed.data.arrivalDTag ?? null,
            parsed.data.surface ?? null,
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
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const accountId = await verifyMagicLink(parsed.data.token);
      if (!accountId) {
        return reply
          .status(401)
          .send({ error: "That login link isn't valid. It may have expired or already been used, so please request another one." });
      }

      const account = await getAccount(accountId);
      if (!account) {
        return reply.status(404).send({ error: "We couldn't find that account." });
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
  //
  // This is a full authentication bypass: a body with any live member's email
  // address returns that member's session cookie. It used to be armed by
  // `NODE_ENV === "development"` alone — one env var, of the kind an operator
  // sets without thinking about what else reads it, and `gateway/.env.example`
  // ships `NODE_ENV=development` as its own default, so the value a fresh prod
  // `.env` is most likely to be copied from is the one that arms it. Compose's
  // `env_file` beats the image's `ENV NODE_ENV=production`, so the Dockerfile is
  // no backstop.
  //
  // So it takes its OWN switch, whose only purpose is this, and it is ANDed
  // rather than substituted: two independent things must both be wrong for the
  // bypass to exist, and neither of them can be got wrong incidentally. The
  // registration logs a warning, because a bypass nobody can see in the log is a
  // bypass nobody will notice has been left on.
  //
  // Local dev needs `DEV_LOGIN_ENABLED=1` in `gateway/.env` — see
  // DEPLOYMENT.md › *Troubleshooting: dev-login answers 404*.
  // ---------------------------------------------------------------------------

  const devLoginArmed =
    process.env.NODE_ENV !== "production" &&
    process.env.DEV_LOGIN_ENABLED === "1";

  if (devLoginArmed) {
    logger.warn(
      "DEV_LOGIN_ENABLED is on — POST /auth/dev-login will issue a session for ANY member by email address. This must never be set in production.",
    );
    app.post("/auth/dev-login", async (req, reply) => {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
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
        return reply.status(404).send({ error: "We couldn't find that account." });
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

  // `allowUndeclaredAge`: this is how the web learns to show the gate — an
  // undeclared member is refused everywhere else (middleware/auth.ts).
  app.get(
    "/auth/me",
    { preHandler: requireAuth, config: { allowUndeclaredAge: true } },
    async (req, reply) => {
    const account = await getAccount(req.session!.sub);
    if (!account) {
      return reply.status(404).send({ error: "We couldn't find that account." });
    }

    // The ONE admin-identity home (middleware/admin.ts): platform_config
    // first, env fallback — the same set requireAdmin checks. A divergent
    // env-only read here meant an admin granted via the dashboard's config
    // editor passed the API guard but /auth/me said isAdmin:false, so
    // AdminShell bounced them to /reader (audit 2026-07-24).
    const adminIds = await getAdminIds();

    // A dial the WEB has to put in a sentence rides the session payload, for
    // the same reason `/auth/open` carries the two arrival dials: a figure
    // typed into copy is a second copy of the dial, and retuning the real one
    // then makes the sentence a lie. `CardSetup` told every reader their card
    // would be charged "at £8" from a literal — on the one surface where they
    // consent to being charged at all.
    const { tabSettlementThresholdPence } = await loadConfig();

    // A reader's pending "Apply to write", so the web shows "Application sent"
    // rather than offering the press again. Not asked of a writer, who has
    // nothing to apply for.
    const canWrite = account.writerAdmittedAt !== null;
    const writerApplication = canWrite
      ? null
      : await pendingWriterApplication(account.id);

    return reply.status(200).send({
      tabSettlementThresholdPence,
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
      subscriptionPricePence: account.subscriptionPricePence,
      annualDiscountPct: account.annualDiscountPct,
      isAdmin: adminIds.includes(account.id),
      // May this member publish articles and sell access? The column the
      // server's writer gate reads (lib/writer-gate.ts), so the web offers no
      // writing control a press would only see refused.
      canWrite,
      // `{ appliedAt }` while a reader's application waits (D3), else null.
      writerApplication,
      usernameChangedAt: account.usernameChangedAt,
      // NULL ⇒ the first-session welcome has never been offered to this member
      // (migration 176). Rides the session payload for the same reason
      // `cardActionRequiredAt` does: the workspace already has it at bootstrap,
      // so gating the sheet costs no extra round trip. Device-independent by
      // construction — the two older seen-flags are `localStorage` and would ask
      // a member to introduce themselves again on every new browser.
      onboardedAt: account.onboardedAt,
      // NULL ⇒ this member has never declared a date of birth (migration 212,
      // L6.1), which is the whole of what the age gate reads. The DATE itself
      // deliberately does not ride the payload — no surface needs it, and a
      // value on the session payload is a value on every page. Same
      // once-per-member construction as `onboardedAt` above and for the same
      // reason: the column is the gate, never a device key.
      ageDeclaredAt: account.ageDeclaredAt,
      // Which legal text this member has accepted, and which one is current.
      // Both sides ride the payload rather than the web carrying a second copy
      // of the version constants: a duplicated version is a value to flip in
      // lockstep, and the half-lit state is a member re-prompted forever by a
      // client that thinks a newer text exists.
      terms: {
        reader: {
          acceptedAt: account.readerTermsAcceptedAt,
          version: account.readerTermsVersion,
          current: currentTermsVersion("reader"),
          isCurrent: termsAcceptanceIsCurrent(
            "reader",
            account.readerTermsVersion,
          ),
        },
        writer: {
          acceptedAt: account.writerTermsAcceptedAt,
          version: account.writerTermsVersion,
          current: currentTermsVersion("writer"),
          isCurrent: termsAcceptanceIsCurrent(
            "writer",
            account.writerTermsVersion,
          ),
        },
      },
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
  // POST /auth/accept-terms — record that this member accepted a legal text
  //
  // The platform sells paid access on a Writer's behalf and runs a tab against
  // a Reader's card; both of those rest on a text the member agreed to, and
  // this is the one route that records the agreement. Two columns per text —
  // when, and WHICH — because a bare timestamp stops meaning anything the
  // first time the wording moves (migration 204).
  //
  // A VERSION THIS SERVER DOES NOT CURRENTLY OFFER IS REFUSED, NOT COERCED.
  // The obvious shortcut is to ignore the client's version and stamp the
  // current one, which would record an acceptance of text the member never
  // saw — the exact failure the version column exists to prevent. So a
  // mismatch is a 400 carrying the current version, and the client re-renders
  // that text and asks again. This is the malformed arm of "a fallback is for
  // an absent value, never a malformed one": an absent version fails zod, a
  // wrong one gets its own answer that says so.
  //
  // FIRST WRITE WINS PER VERSION. `WHERE … IS DISTINCT FROM $2` means a second
  // press, a retry or a second tab does not move a timestamp that is already
  // recording when this text was accepted. Re-accepting is therefore an
  // idempotent no-op rather than a quiet rewrite of the record, and the route
  // answers 200 either way: the caller's question is "has this member accepted
  // the current text", and after both outcomes the answer is yes.
  //
  // The comparison runs through `termsAcceptanceIsCurrent`, never `===` — the
  // stored string carries a text sub-version that is deliberately ignored, so
  // a typo fix does not re-prompt the whole membership.
  //
  // WHAT THIS ROUTE IS NOT. It records; it refuses nothing else. The refusals
  // that make an acceptance a PRECONDITION live where the acts do, and they
  // read these columns through `lib/terms-gate.ts`: /auth/connect-card takes
  // the reader's version in the same statement as the card, the gate pass
  // refuses a card-holder who is behind, and the three paywalled-publish doors
  // refuse a writer who is. This route is what the web POSTs to when one of
  // those refusals puts the document on screen — and, for the writer, what it
  // POSTs to BEFORE the first paid publish, so the refusal is never reached.
  // What each document rests on, and what is outstanding:
  // docs/adr/LEGAL-BRAKES.md.
  // ---------------------------------------------------------------------------

  const AcceptTermsSchema = z.object({
    kind: z.enum(TERMS_KINDS),
    version: z.string().min(1).max(32),
  });

  // The two column pairs, keyed by the wire's own vocabulary. A lookup rather
  // than an if/else so that adding a third text is a row here and a member of
  // TERMS_KINDS, and cannot be half-added.
  const TERMS_COLUMNS: Record<
    TermsKind,
    { acceptedAt: string; version: string }
  > = {
    reader: {
      acceptedAt: "reader_terms_accepted_at",
      version: "reader_terms_version",
    },
    writer: {
      acceptedAt: "writer_terms_accepted_at",
      version: "writer_terms_version",
    },
  };

  app.post(
    "/auth/accept-terms",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = AcceptTermsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const { kind, version } = parsed.data;
      const current = currentTermsVersion(kind);

      // Refused BEFORE any write — the test asserts that no UPDATE ran, not
      // just that the status was 400.
      if (!termsAcceptanceIsCurrent(kind, version)) {
        return reply.status(400).send({
          error: "terms_version_mismatch",
          kind,
          current,
        });
      }

      const cols = TERMS_COLUMNS[kind];
      // Column names come from the table above, never from the request: the
      // wire value has already been narrowed to TERMS_KINDS by zod, and the
      // identifiers themselves are literals in this file.
      await pool.query(
        `UPDATE accounts
            SET ${cols.acceptedAt} = now(), ${cols.version} = $2
          WHERE id = $1
            AND ${cols.version} IS DISTINCT FROM $2`,
        [req.session!.sub, current],
      );

      invalidateAuthCache(req.session!.sub);
      return reply.status(200).send({ ok: true, kind, version: current });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/declare-age — the other two doors to `accounts.date_of_birth`
  //
  // Email signup asks in its own form (`signupSchema`). This route is for the
  // two members that form cannot reach:
  //
  //   · somebody who arrived through Google, whose account was provisioned
  //     from what Google sent and who is asked on their first landing — the
  //     provisioner cannot ask, because there is no form in an OAuth callback;
  //   · everybody who was already a member when L6.1 shipped, asked once on
  //     their next sign-in.
  //
  // ONE ROUTE FOR BOTH, because they are the same fact about a member
  // (`age_declared_at IS NULL`) and one surface asks it. Two routes would be
  // two chances for the rule to differ, and the web would have to know which
  // kind of member it was looking at to pick one — which it cannot, since
  // "provisioned by Google five minutes ago" and "member since 2024" are the
  // same NULL.
  //
  // GATED ON THE MEMBER, NEVER ON A DEVICE KEY (feeds.md). The column IS the
  // gate: a `localStorage` flag asks the same person again on every browser,
  // and answers "already asked" on a browser where they never were.
  //
  // FIRST WRITE WINS. `WHERE age_declared_at IS NULL` means a second press, a
  // retry or a second tab cannot move a declaration that is already recorded —
  // and a member cannot revise the answer through this door at all. That is
  // deliberate and it is the point of the record: a declaration somebody can
  // edit afterwards records nothing about what they said the first time. A
  // correction is an operator act (and a member who genuinely mistyped is a
  // support conversation, which is the right weight for it).
  //
  // A DECLARATION UNDER 18 IS REFUSED AND NOT RECORDED. The schema refuses it,
  // so nothing is written and the member stays at the gate. There is no
  // suspension here, deliberately: nothing has been verified, so acting on the
  // answer would be acting on an unverified assertion — and the member can in
  // any case type another date, which is true of every self-declaration and is
  // why A1 chose a declaration knowing it. What the platform gets is the
  // dated record of having asked, which is what it did not have at all.
  // ---------------------------------------------------------------------------

  app.post(
    "/auth/declare-age",
    {
      preHandler: requireAuth,
      // The one door that must open to an undeclared member, by definition.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" }, allowUndeclaredAge: true },
    },
    async (req, reply) => {
      // Built per request, for `signupSchema`'s reason: the clock is an
      // argument, and a schema frozen at module load ages with the process.
      const parsed = z
        .object({ dateOfBirth: dateOfBirthSchema(new Date()) })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(ageRefusal(parsed.error) ?? zodValidationError(parsed.error));
      }

      // `age_declared_at` is `now()` and never a client value: the column
      // records when WE asked, which is a fact about this request.
      const { rowCount } = await pool.query(
        `UPDATE accounts
            SET date_of_birth = $2, age_declared_at = now()
          WHERE id = $1
            AND age_declared_at IS NULL`,
        [req.session!.sub, parsed.data.dateOfBirth],
      );

      invalidateAuthCache(req.session!.sub);
      // 200 either way. The caller's question is "has this member declared",
      // and after both outcomes the answer is yes — the same contract
      // /auth/accept-terms keeps, and for the same reason: a second tab losing
      // the race has not failed at anything.
      return reply
        .status(200)
        .send({ ok: true, recorded: (rowCount ?? 0) > 0 });
    },
  );

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
        return reply.status(400).send(zodValidationError(parsed.error));
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
        return reply.status(404).send({ error: "We couldn't find that account." });
      }

      if (account.stripeConnectId) {
        return reply.status(409).send({ error: "Stripe already connected" });
      }

      // A Connect account is how a WRITER is paid, so a reader has no reason
      // to open one — but this route is also how money already earned leaves,
      // and a reader holding earnings must never be locked out of it. So it
      // asks `canWrite OR holdsWriterLedger`, never `requireWriter`
      // (READER-WRITER-SPLIT-ADR §4.7: `money-out`).
      if (
        account.writerAdmittedAt === null &&
        !(await holdsWriterLedger(accountId))
      ) {
        return reply.status(403).send(writerAccessRefusal());
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
          refresh_url: `${requireEnv("APP_URL")}/settings?refresh=true`,
          return_url: `${requireEnv("APP_URL")}/settings?onboarding=complete`,
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
        return reply.status(404).send({ error: "We couldn't find that account." });
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

  // The reader's acceptance of the Reader Terms rides the same request as the
  // card, because A3 makes them one act. REQUIRED, never optional: a value the
  // client may omit is a value a stale client omits, and the card would then
  // register with nothing recorded — which is the state this route exists to
  // stop existing.
  const ConnectCardSchema = z.object({
    setupIntentId: z.string().min(1),
    readerTermsVersion: z.string().min(1).max(32),
  });

  app.post(
    "/auth/connect-card",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ConnectCardSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const accountId = req.session!.sub;
      const account = await getAccount(accountId);

      if (!account) {
        return reply.status(404).send({ error: "We couldn't find that account." });
      }

      // Refused BEFORE Stripe is touched, and never coerced — the same rule
      // and the same 400 as /auth/accept-terms. Stamping the current version
      // over a client that showed an older one would record an acceptance of
      // text the reader never saw, and here it would do it while attaching
      // their card.
      if (
        !termsAcceptanceIsCurrent("reader", parsed.data.readerTermsVersion)
      ) {
        return reply.status(400).send({
          error: "terms_version_mismatch",
          kind: "reader",
          current: currentTermsVersion("reader"),
        });
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

        // Record on account — the customer id, the acceptance that authorised
        // it and the cleared settlement back-off flag (S1), in one statement.
        await connectPaymentMethod(
          accountId,
          customerId,
          currentTermsVersion("reader"),
        );

        // /auth/me answers from a cache; the terms fields it now carries have
        // just moved.
        invalidateAuthCache(accountId);

        // Ask the payment service to convert provisional reads. Not awaited:
        // the card IS connected whatever it answers, and the call retries for
        // up to ~30s. A call that never lands is picked up by the payment
        // service's reconcile sweep (CA-F16c, `card-connected-client.ts`).
        void notifyCardConnected(accountId);

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
  // DELETE /auth/payment-method — remove the card (Reader Terms 2.4)
  //
  // "You can change or remove it in your account settings at any time; removing
  // it will pause paid reading until you add another." There was no route: the
  // sentence was true of the Terms and of nothing else, and a reader who wanted
  // their card off the platform had no way to take it off.
  //
  // THREE THINGS IT DOES AND ONE IT MUST NOT DO.
  //
  //  1. Detaches every card the customer has at Stripe. Every card setup
  //     attaches a new PaymentMethod and makes it the default; the previous one
  //     stays attached. So "remove my card" that detached only the default
  //     would leave the reader's older cards sitting on our customer — the
  //     thing they asked us to stop holding.
  //  2. Clears `accounts.stripe_customer_id`, which IS the "this reader has a
  //     usable card" signal everywhere (auth/me's hasPaymentMethod, the gate's
  //     accrued-vs-provisional split, settlement's attempt gate). Nulling it is
  //     what pauses paid reading; the customer object itself stays at Stripe,
  //     carrying the settlement history, and a later card mints a fresh one.
  //  3. Leaves the tab exactly as it is. THE DEBT IS NOT FORGIVEN — Reader
  //     Terms 6.3: "If you stop using all.haus with an unpaid tab, the amount
  //     stays owed and we may ask you for it". Nothing here touches
  //     reading_tabs, read_events or the ledger, and a test asserts that.
  //
  // What it does NOT do is take money on the way out. Settling first would be a
  // charge the reader did not ask for, fired by a button that says "remove"
  // (no money moves without a gesture, and this gesture is not that one); the
  // reader who wants to pay first has Settle now, one panel above.
  //
  // THE RACE, NAMED RATHER THAN GUARDED: a settlement can be mid-flight when
  // this lands. Its Stripe create then fails terminally (the method is gone) or
  // succeeds (the create beat the detach) — in the first case the settlement is
  // marked failed, the tab unfreezes and the debt stands, in the second the
  // reader is charged for what they already owed. Neither loses money, and both
  // are better than blocking a reader from removing their card while an
  // unrelated charge is in flight.
  // ---------------------------------------------------------------------------

  // Rate-limited on the ACCOUNT, like the two routes below it that can move
  // money: this one calls Stripe twice per press (list + detach per card), and
  // behind nginx `req.ip` is the proxy's, so an IP bucket would be one bucket
  // for everybody. 6/minute is far above any real use of a control a reader
  // presses once.
  app.delete(
    "/auth/payment-method",
    {
      preHandler: requireAuth,
      config: {
        rateLimit: {
          max: 6,
          timeWindow: "1 minute",
          keyGenerator: accountMoneyRateLimitKey,
        },
      },
    },
    async (req, reply) => {
      const accountId = req.session!.sub;

      const { rows } = await pool.query<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM accounts WHERE id = $1`,
        [accountId],
      );
      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that account." });
      }
      const customerId = rows[0].stripe_customer_id;
      if (!customerId) {
        // Already gone. Not an error the reader can act on, and not a success
        // either — say which, so a UI that got out of step can resync.
        return reply.status(409).send({ error: "no_payment_method" });
      }

      let detached = 0;
      let failed = 0;
      try {
        const methods = await stripe.paymentMethods.list({
          customer: customerId,
          type: "card",
        });

        // A PARTIAL OUTCOME IS NOT A TOTAL ONE: one card that will not detach
        // is a fact about that card. The loop does not abort on it, and the
        // shortfall is counted rather than silently omitted.
        for (const pm of methods.data) {
          try {
            await stripe.paymentMethods.detach(pm.id);
            detached++;
          } catch (err) {
            failed++;
            logger.error(
              { err, accountId, paymentMethodId: pm.id },
              "Failed to detach a payment method",
            );
          }
        }

        // Every card still attached and none removed: nothing has changed at
        // Stripe, so nothing changes here either. Clearing the customer id
        // anyway would tell the reader their card was gone while Stripe still
        // held all of them.
        if (methods.data.length > 0 && detached === 0) {
          return reply
            .status(502)
            .send({ error: "Could not remove the card. Please try again." });
        }
      } catch (err) {
        logger.error(
          { err, accountId },
          "Failed to list payment methods for removal",
        );
        return reply
          .status(502)
          .send({ error: "Could not remove the card. Please try again." });
      }

      // The tab is untouched by construction — this statement names one column.
      await pool.query(
        `UPDATE accounts SET stripe_customer_id = NULL, updated_at = now()
         WHERE id = $1`,
        [accountId],
      );
      invalidateAuthCache(accountId);

      logger.info(
        { accountId, detached, failed },
        "Payment method removed — paid reading paused, tab unchanged",
      );
      return reply
        .status(200)
        .send({ ok: true, hasPaymentMethod: false, detached, failed });
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
  // Settles any outstanding reading tab (Reader Terms 12.1), then cancels
  // subscriptions, soft-deletes articles and hard-deletes notes (both with
  // kind-5 events), and soft-deletes the account row.
  //
  // THE FINAL CHARGE COMES FIRST, AND OUTSIDE THE TRANSACTION. "Any outstanding
  // tab becomes payable immediately and we will charge your registered payment
  // method" — and money is the one thing a deleted account cannot come back to
  // sort out. It cannot sit inside the deletion transaction: the charge is a
  // Stripe call, so holding a transaction open across it would hold every row
  // this route touches for the length of a network round trip, and a rollback
  // could not un-charge the card anyway.
  //
  // A4 (operator decision, 2026-09-16): NO FEE ON IT. The reader pays the tab
  // and not a penny more — which is what the code already does, since the
  // platform's cut comes out of what is collected rather than being added to
  // it, and Reader Terms 6.3 promises exactly that ("You will never pay more
  // than the price of the content you read... The deferral is free"). Named
  // here because the promise is easy to break by adding a "closure fee" to a
  // route that has no other reason to refuse one.
  // ---------------------------------------------------------------------------

  const DeleteAccountSchema = z.object({
    emailConfirmation: z.string().email(),
  });

  app.post(
    "/auth/delete-account",
    {
      preHandler: requireAuth,
      // It takes a final CHARGE now, so it joins the money routes' bucket. The
      // email confirmation already makes this hard to fire by accident; the
      // limit is about a repeated request costing a reader repeated charges.
      config: {
        rateLimit: {
          max: 6,
          timeWindow: "1 minute",
          keyGenerator: accountMoneyRateLimitKey,
        },
      },
    },
    async (req, reply) => {
      const parsed = DeleteAccountSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
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
        return reply.status(404).send({ error: "We couldn't find that account." });
      }
      if (
        accountRows[0].email.toLowerCase() !==
        parsed.data.emailConfirmation.toLowerCase()
      ) {
        return reply.status(400).send({ error: "That isn't the email address on your account." });
      }

      // Reader Terms 12.1 — settle what is owed BEFORE the account goes.
      //
      // The balance is read from `reading_tabs`, the locked operational total
      // settlement itself reserves against, not the ledger view: this is the
      // figure the charge will be built from, and asking the other one would
      // mean deciding whether to charge from a number that is not the number.
      const tabRow = await pool.query<{ balance_pence: number }>(
        `SELECT balance_pence FROM reading_tabs WHERE reader_id = $1`,
        [accountId],
      );
      const outstandingPence = tabRow.rows[0]?.balance_pence ?? 0;

      if (outstandingPence > 0) {
        const outcome = await requestSettlement(accountId, "account_closure");
        switch (outcome.kind) {
          case "charged":
          case "nothing_due":
            break;
          case "below_minimum":
            // Under Stripe's 30p floor: there is no charge that can be made,
            // and a member may not be held on the platform by a debt the
            // payment network will not let them pay. The tab row survives the
            // soft delete carrying the amount (Reader Terms 6.3 — it stays
            // owed), and the deletion goes ahead.
            logger.warn(
              { accountId, balancePence: outcome.balancePence },
              "Account closing with a tab below the Stripe minimum — uncollected, debt stands",
            );
            break;
          case "no_card":
            // Nothing to charge. Same disposition and the same reason: a reader
            // with no payment method cannot be made to leave one behind.
            logger.warn(
              { accountId, outstandingPence },
              "Account closing with an outstanding tab and no card — uncollected, debt stands",
            );
            break;
          case "card_declined":
          case "card_action_required":
            // A refusal the reader can act on: attach a working card and press
            // delete again — or remove the card entirely, at which point the
            // no_card arm above lets them go with the debt standing. The one
            // thing this must not do is delete the account while the charge is
            // outstanding and collectable.
            return reply.status(402).send({
              error: "final_settlement_failed",
              message:
                "The card on file was declined, so your reading tab is still open. Add a working card and try again.",
              outstandingPence,
            });
          case "in_flight":
          case "ambiguous":
            // NEVER PROCEED ON A MAYBE. `ambiguous` means the charge may be
            // live; `in_flight` means one certainly is. Deleting on top of
            // either leaves a payment against an account that no longer exists
            // to explain it, so the reader is asked to come back in a moment —
            // by which time the settlement has confirmed and the tab reads 0.
            return reply.status(409).send({
              error: "final_settlement_pending",
              message:
                "We are completing the final payment for your reading tab. Please try again in a few minutes.",
              outstandingPence,
            });
        }
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

        // Enqueue kind 5 deletion events (non-fatal — DB is source of truth).
        // relay_outbox owns retry so a relay blip during account deletion no
        // longer leaves tombstones un-published.
        //
        // ONE BATCH, AND THE SHORTFALL IS COUNTED (CA-A8, 2026-09-29). This
        // signed each tombstone with its own key-custody round-trip, inside a
        // per-item try that logged and moved on — so past the 121st piece
        // every sign answered 429 (the single route's per-signer budget) and
        // the tail of a prolific member's work stayed on the relay, with N
        // error lines and no figure anywhere saying how many. All of them go
        // in one `signEvents` call (key-custody's batch route, its own budget);
        // if THAT fails the tombstones are the shortfall, counted whole, and
        // the deletion still commits — the DB is the source of truth and a
        // relay tombstone is a courtesy to the network, never the deletion.
        const tombstones: Array<{
          entityType: "article_deletion" | "note_deletion";
          entityId: string;
          template: { kind: number; content: string; tags: string[][]; created_at: number };
        }> = [];
        const stamp = Math.floor(Date.now() / 1000);
        for (const article of articles) {
          tombstones.push({
            entityType: "article_deletion",
            entityId: article.id,
            template: {
              kind: 5,
              content: "",
              tags: [
                ["e", article.nostr_event_id],
                ["a", `30023:${accountRows[0].nostr_pubkey}:${article.nostr_d_tag}`],
              ],
              created_at: stamp,
            },
          });
        }
        for (const note of notes) {
          tombstones.push({
            entityType: "note_deletion",
            entityId: note.id,
            template: { kind: 5, content: "", tags: [["e", note.nostr_event_id]], created_at: stamp },
          });
        }
        let tombstonesEnqueued = 0;
        let tombstonesSkipped = 0;
        if (tombstones.length > 0) {
          let signed: Awaited<ReturnType<typeof signEvents>> | null = null;
          try {
            signed = await signEvents(accountId, tombstones.map((t) => t.template));
          } catch (err) {
            tombstonesSkipped = tombstones.length;
            logger.error(
              { err, accountId, total: tombstones.length },
              "Account deletion: tombstones could not be signed — none enqueued",
            );
          }
          if (signed) {
            for (let i = 0; i < tombstones.length; i++) {
              try {
                await enqueueRelayPublish(client, {
                  entityType: tombstones[i].entityType,
                  entityId: tombstones[i].entityId,
                  signedEvent: signed[i] as SignedNostrEvent,
                });
                tombstonesEnqueued += 1;
              } catch (err) {
                tombstonesSkipped += 1;
                logger.error(
                  { err, accountId, entityId: tombstones[i].entityId },
                  "Account deletion: tombstone enqueue failed for one item",
                );
              }
            }
          }
        }
        if (tombstonesSkipped > 0) {
          logger.warn(
            { accountId, total: tombstones.length, enqueued: tombstonesEnqueued, skipped: tombstonesSkipped },
            "Account deletion: tombstone shortfall",
          );
        }

        // Soft-delete the account — hard-delete would violate ON DELETE RESTRICT
        // FKs on articles, read_events, vote_charges, unlock_records, etc.
        // Clean up relations that won't be useful post-deletion.
        await client.query(
          "DELETE FROM follows WHERE follower_id = $1 OR followee_id = $1",
          [accountId],
        );
        // The two intention lists (bookmarks, feed_saves) were dropped in
        // migration 189 and their sweeps with them.
        //
        // reading_log and reading_positions are cleared HERE rather than left
        // to their FK: account deletion is a SOFT delete (see below — hard
        // deletion would violate ON DELETE RESTRICT on articles, read_events
        // and the rest), so `reading_log`'s ON DELETE CASCADE never fires. A
        // deleted account's reading is the one thing on this list that is
        // nobody's business afterwards, so it goes with the display name and
        // the avatar.
        await client.query("DELETE FROM reading_log WHERE user_id = $1", [
          accountId,
        ]);
        await client.query("DELETE FROM reading_positions WHERE user_id = $1", [
          accountId,
        ]);

        // Network presences carry live third-party credentials, so a deleted
        // account must not keep them (MIRROR-AUDIT §2.10). Nothing wrote
        // `deprovisioned` anywhere before this: the soft delete left every
        // OAuth link valid and `outbound-token-refresh` kept refreshing them,
        // which is holding a credential for a member who has left.
        //
        // The order matters. Read the atproto DIDs off the presence rows
        // FIRST — that column is the only join to `atproto_oauth_sessions`,
        // and nulling the presence before deleting the session would strand
        // it for good.
        const { rows: atpDids } = await client.query<{ external_id: string }>(
          `SELECT external_id FROM network_presences
            WHERE account_id = $1 AND protocol = 'atproto'
              AND external_id IS NOT NULL`,
          [accountId],
        );
        if (atpDids.length > 0) {
          await client.query(
            `DELETE FROM atproto_oauth_sessions WHERE did = ANY($1::text[])`,
            [atpDids.map((r) => r.external_id)],
          );
        }
        // Belt and braces for a session whose presence row is already gone:
        // the column migration 194 added is what makes this possible.
        await client.query(
          `DELETE FROM atproto_oauth_sessions WHERE account_id = $1`,
          [accountId],
        );
        await client.query(
          `UPDATE network_presences
              SET lifecycle_state = 'deprovisioned', is_valid = FALSE,
                  credentials_enc = NULL, updated_at = now()
            WHERE account_id = $1`,
          [accountId],
        );

        await client.query(
          `UPDATE accounts
           SET status = 'deleted', email = 'deleted-' || id || '@deleted',
               display_name = NULL, bio = NULL, avatar_blossom_url = NULL,
               date_of_birth = NULL, age_declared_at = NULL,
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
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const accountId = req.session!.sub;
      const newEmail = parsed.data.newEmail.toLowerCase().trim();

      // Check if email is already in use — return success either way to
      // prevent email enumeration. If taken, skip the DB write + email. The
      // body must be IDENTICAL to the success path's below: a `message` only
      // this branch carried was itself the answer to "is this address taken".
      const { rows: existing } = await pool.query(
        "SELECT id FROM accounts WHERE email = $1 AND id != $2",
        [newEmail, accountId],
      );
      if (existing.length > 0) {
        return reply.status(200).send({ ok: true });
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
      const appUrl = requireEnv("APP_URL");
      const verifyUrl = `${appUrl}/auth/verify?emailChange=${encodeURIComponent(token)}`;

      try {
        await sendEmail({
          to: newEmail,
          ...renderEmail(emailChangeVerificationEmail({ verifyUrl })),
        });
      } catch (err) {
        logger.error(
          { err, accountId },
          "Failed to send email change verification",
        );
        return reply
          .status(500)
          .send({ error: "Couldn't send the confirmation email. Please try again." });
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
  //
  // AN EMAIL CHANGE IS THE ONE ACT THAT MOVES THE ACCOUNT'S WAY IN, so it is
  // recorded, announced to the address it replaced, and it signs out every
  // other device (migration 273; follow-up (f), operator ruling 2026-10-02).
  // Login is by email and the key export confirms by email, so a stolen session
  // that could quietly move the address could then take the custodial key,
  // which cannot be rotated. Four things ride the one transaction:
  //   - the swap, plus `sessions_invalidated_at`, which ends every session;
  //   - an `account_email_changes` row naming the address replaced — the undo
  //     restores THAT one, and the export hold is read off it;
  //   - the undo token (purpose `email_change_undo`), good for the hold;
  //   - the notice to the old address, SENT LAST, INSIDE the transaction. A
  //     change that lands with no notice is the silent theft this exists to
  //     end, so a failed send rolls the change back and the confirmation link
  //     still works for a retry. The opposite order's failure — a commit that
  //     fails after the send — leaves an email describing a change that did
  //     not happen, whose undo link then finds nothing: noise, not harm.
  // The device that confirms keeps its session if it already had one for this
  // account (re-issued after the commit, so its iat is not older than the
  // invalidation); it is never given one it did not have.
  // ---------------------------------------------------------------------------

  const VerifyEmailChangeSchema = z.object({
    token: z.string().min(1),
  });

  const EXPIRED_CHANGE_LINK =
    "That confirmation link isn't valid. It may have expired or already been used, so please ask for another one in Settings.";

  app.post(
    "/auth/verify-email-change",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = VerifyEmailChangeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const tokenHash = crypto
        .createHash("sha256")
        .update(parsed.data.token)
        .digest("hex");

      const holdDays = await emailChangeExportHoldDays();
      const appUrl = requireEnv("APP_URL");

      type Outcome =
        | { kind: "invalid" }
        | { kind: "expired"; accountId: string }
        | { kind: "taken"; accountId: string }
        | { kind: "changed"; accountId: string; nostrPubkey: string };

      const outcome = await withTransaction<Outcome>(async (client) => {
        const { rows } = await client.query<{
          id: string;
          email: string | null;
          pending_email: string;
          nostr_pubkey: string;
          email_verification_requested_at: Date | null;
        }>(
          `SELECT id, email, pending_email, nostr_pubkey, email_verification_requested_at
             FROM accounts
            WHERE email_verification_token = $1 AND pending_email IS NOT NULL
            FOR UPDATE`,
          [tokenHash],
        );
        if (rows.length === 0) return { kind: "invalid" };
        const row = rows[0];

        // 24-hour TTL
        const requestedAt = row.email_verification_requested_at;
        if (requestedAt && Date.now() - requestedAt.getTime() > 24 * 60 * 60 * 1000) {
          return { kind: "expired", accountId: row.id };
        }

        // Check the new email hasn't been taken since the request was made
        const { rows: conflict } = await client.query(
          "SELECT id FROM accounts WHERE email = $1 AND id != $2",
          [row.pending_email, row.id],
        );
        if (conflict.length > 0) return { kind: "taken", accountId: row.id };

        await client.query(
          `UPDATE accounts
              SET email = $1, pending_email = NULL, email_verification_token = NULL,
                  sessions_invalidated_at = now(), updated_at = now()
            WHERE id = $2`,
          [row.pending_email, row.id],
        );
        const { rows: change } = await client.query<{ id: string; changed_at: Date }>(
          `INSERT INTO account_email_changes (account_id, old_email, new_email)
           VALUES ($1, $2, $3)
           RETURNING id, changed_at`,
          [row.id, row.email, row.pending_email],
        );

        // No address on file before (a seeded account): nobody to tell and no
        // undo to mint. The row above still starts the export hold.
        if (row.email && row.email !== row.pending_email) {
          const { token } = await requestStepUpToken(
            row.id,
            "email_change_undo",
            new Date(change[0].changed_at.getTime() + holdDays * 24 * 60 * 60 * 1000),
            client,
          );
          const undoUrl =
            `${appUrl}/auth/undo-email-change?change=${encodeURIComponent(change[0].id)}` +
            `&token=${encodeURIComponent(token)}`;
          await sendEmail({
            to: row.email,
            ...renderEmail(
              emailChangedNoticeEmail({
                newEmailMasked: maskEmail(row.pending_email),
                changedAt: change[0].changed_at,
                undoUrl,
                holdDays,
              }),
            ),
          });
        }
        return { kind: "changed", accountId: row.id, nostrPubkey: row.nostr_pubkey };
      }).catch((err: unknown) => {
        logger.error({ err }, "Email change confirmation failed");
        return null;
      });

      if (outcome === null) {
        return reply
          .status(500)
          .send({ error: "We couldn't finish changing your email. Your link still works, so please try it again in a moment." });
      }
      if (outcome.kind === "invalid") {
        return reply.status(400).send({ error: EXPIRED_CHANGE_LINK });
      }
      if (outcome.kind === "expired" || outcome.kind === "taken") {
        await pool.query(
          `UPDATE accounts SET pending_email = NULL, email_verification_token = NULL WHERE id = $1`,
          [outcome.accountId],
        );
        return outcome.kind === "expired"
          ? reply.status(400).send({ error: EXPIRED_CHANGE_LINK })
          : reply
              .status(409)
              .send({ error: "That email address now belongs to another account, so we couldn't change yours." });
      }

      invalidateAuthCache(outcome.accountId);
      // verifySession can throw only on a broken deployment (session.ts); the
      // change has committed by now, so that must not answer as its failure.
      const session = await verifySession(req).catch(() => null);
      if (session?.sub === outcome.accountId) {
        await createSession(reply, { id: outcome.accountId, nostrPubkey: outcome.nostrPubkey });
      } else {
        destroySession(reply);
      }

      logger.info({ accountId: outcome.accountId }, "Email changed successfully");
      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/undo-email-change — the old address takes the account back
  //
  // The link in the notice above lands on a web page that ASKS; this POST acts
  // (a mail scanner presses every GET). No session, by necessity: the person
  // holding this link is the one a stolen session has just locked out, and
  // every device was signed out by the change anyway. So the credential is the
  // token alone — minted for one account and one purpose, claimed against the
  // change row's own account — and every refusal but one answers alike, so the
  // route says nothing about which changes exist. The exception is an old
  // address someone else has since taken, which the holder of a valid token
  // needs to hear, and which is asked BEFORE the claim so the token survives.
  //
  // The undo restores the change's OWN old address, signs out every device,
  // marks this change and every later one undone (lifting the export hold),
  // and spends any outstanding export confirmation, which was mailed to an
  // address that is no longer the account's.
  // ---------------------------------------------------------------------------

  const UndoEmailChangeSchema = z.object({
    change: z.string(),
    token: z.string().min(1),
  });

  app.post(
    "/auth/undo-email-change",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = UndoEmailChangeSchema.safeParse(req.body);
      const refused = () =>
        reply.status(403).send({
          error: "undo_invalid",
          message:
            "That link can't undo anything. It may have expired, already been used, or the change was undone another way. If your account still isn't yours, write to us.",
        });
      if (!parsed.success || !isUuid(parsed.data.change)) return refused();
      const { change: changeId, token } = parsed.data;

      type Outcome = { kind: "refused" } | { kind: "taken" } | { kind: "undone"; accountId: string };
      const outcome = await withTransaction<Outcome>(async (client) => {
        const { rows } = await client.query<{
          account_id: string;
          old_email: string | null;
          changed_at: Date;
          undone_at: Date | null;
        }>(
          `SELECT account_id, old_email, changed_at, undone_at
             FROM account_email_changes WHERE id = $1 FOR UPDATE`,
          [changeId],
        );
        const row = rows[0];
        if (!row || row.undone_at || !row.old_email) return { kind: "refused" };

        const { rows: taken } = await client.query(
          "SELECT 1 FROM accounts WHERE email = $1 AND id != $2",
          [row.old_email, row.account_id],
        );
        if (taken.length > 0) return { kind: "taken" };

        if (!(await claimStepUpToken(client, token, row.account_id, "email_change_undo"))) {
          return { kind: "refused" };
        }

        await client.query(
          `UPDATE accounts
              SET email = $1, pending_email = NULL, email_verification_token = NULL,
                  sessions_invalidated_at = now(), updated_at = now()
            WHERE id = $2`,
          [row.old_email, row.account_id],
        );
        await client.query(
          `UPDATE account_email_changes SET undone_at = now()
            WHERE account_id = $1 AND changed_at >= $2 AND undone_at IS NULL`,
          [row.account_id, row.changed_at],
        );
        await client.query(
          `UPDATE magic_links SET used_at = now()
            WHERE account_id = $1 AND purpose = 'key_export' AND used_at IS NULL`,
          [row.account_id],
        );
        return { kind: "undone", accountId: row.account_id };
      });

      if (outcome.kind === "refused") return refused();
      if (outcome.kind === "taken") {
        return reply.status(409).send({
          error: "undo_address_taken",
          message:
            "Your old address now belongs to another account, so we can't put it back. Please write to us and we'll sort it out by hand.",
        });
      }

      invalidateAuthCache(outcome.accountId);
      destroySession(reply);
      logger.warn({ accountId: outcome.accountId, changeId }, "Email change undone from the old address");
      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/change-username — change username (30-day cooldown)
  //
  // Validates format, checks availability, enforces the 30-day cooldown, and
  // records the old handle with a 90-day window.
  //
  // RECORDS, NOT REDIRECTS. Nothing reads `previous_username` or
  // `username_redirect_until` — every username lookup on the platform is a bare
  // `WHERE username = $1` — so a rename breaks every existing link to the
  // member's profile the moment it lands. The columns are kept because they are
  // what a redirect would be built on; `shared/src/auth/username-derive.ts`
  // states what building it would have to decide first.
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
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const accountId = req.session!.sub;
      const newUsername = parsed.data.newUsername.toLowerCase();

      if (!USERNAME_RE.test(newUsername)) {
        return reply.status(400).send({ error: USERNAME_RULE_MESSAGE });
      }
      if (isReservedUsername(newUsername)) {
        return reply.status(400).send({ error: USERNAME_RESERVED_MESSAGE });
      }

      const { rows: account } = await pool.query<{
        username: string | null;
        username_changed_at: Date | null;
      }>("SELECT username, username_changed_at FROM accounts WHERE id = $1", [
        accountId,
      ]);

      if (account.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that account." });
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
            error: "You can only change your username once every 30 days.",
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
        return reply.status(409).send({ error: "That username is taken." });
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
      if (isReservedUsername(username)) {
        return reply
          .status(200)
          .send({ available: false, reason: "Reserved" });
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
