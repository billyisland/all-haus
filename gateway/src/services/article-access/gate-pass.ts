import { createHmac } from "crypto";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireEnv } from "@platform-pub/shared/lib/env.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { checkArticleAccess } from "./access-check.js";
import {
  recordSubscriptionRead,
  recordPurchaseUnlock,
} from "./unlock-records.js";

// =============================================================================
// Gate-pass orchestrator
//
// Single entry point for the reader-passes-paywall flow. The route handler
// translates the typed result into HTTP status + body; nothing else in the
// codebase calls the payment service /gate-pass endpoint directly.
//
// Flow:
//   1. Look up article
//   2. Check for free access (own / member / unlock / subscription) →
//      issue key without charging if granted
//   3. Reject invitation_only articles
//   4. Get-or-create reader's tab + compute keyed reader pubkey hash
//   5. Call payment service /gate-pass to charge & record the read
//   6. Persist permanent unlock so a key-issuance failure on retry is free
//   7. Call key service /key to fetch the encrypted content key
// =============================================================================

const KEY_SERVICE_URL = requireEnv("KEY_SERVICE_URL");
const PAYMENT_SERVICE_URL = requireEnv("PAYMENT_SERVICE_URL");
const READER_HASH_KEY = requireEnv("READER_HASH_KEY");
const INTERNAL_SERVICE_TOKEN = requireEnv("INTERNAL_SERVICE_TOKEN");
const INTERNAL_SECRET = requireEnv("INTERNAL_SECRET");

interface GatePassInput {
  readerId: string;
  readerPubkey: string;
  nostrEventId: string;
}

interface GatePassSuccessBody {
  readEventId: string | null;
  readState: string;
  encryptedKey: unknown;
  algorithm: unknown;
  isReissuance: boolean;
  allowanceJustExhausted?: boolean;
  ciphertext?: unknown;
}

type GatePassResult =
  | { kind: "success"; body: GatePassSuccessBody }
  | { kind: "not_found" }
  | { kind: "not_gated" }
  | { kind: "misconfigured" }
  | { kind: "invitation_required" }
  | { kind: "payment_required"; error: string }
  | { kind: "key_issuance_failed_after_payment"; readEventId: string | null }
  | { kind: "service_unreachable" }
  | { kind: "service_error" };

export async function performGatePass(
  input: GatePassInput,
): Promise<GatePassResult> {
  const { readerId, readerPubkey, nostrEventId } = input;

  try {
    // Step 1: Look up article
    const articleRow = await pool.query<{
      id: string;
      writer_id: string;
      price_pence: number;
      access_mode: string;
      publication_id: string | null;
    }>(
      `SELECT id, writer_id, price_pence, access_mode, publication_id
       FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL AND published_at IS NOT NULL`,
      [nostrEventId],
    );

    if (articleRow.rows.length === 0) {
      return { kind: "not_found" };
    }

    const article = articleRow.rows[0];
    if (article.access_mode === "public") {
      return { kind: "not_gated" };
    }

    // Step 1b: never charge for undeliverable content. A paywalled article
    // must have a vault key (the encrypted body) and a chargeable price
    // before ANY money moves. A row that fails this check is a broken publish
    // (e.g. the vault-encryption step failed after indexing) — refusing here
    // turns "reader pays, then key issuance 404s forever" into a clean error.
    if (article.access_mode === "paywalled") {
      const vaultRow = await pool.query<{ ok: number }>(
        `SELECT 1 AS ok FROM vault_keys WHERE article_id = $1`,
        [article.id],
      );
      const hasVaultKey = vaultRow.rows.length > 0;
      const priceValid =
        article.price_pence !== null && article.price_pence >= 1;
      if (!hasVaultKey || !priceValid) {
        logger.error(
          {
            articleId: article.id,
            nostrEventId,
            pricePence: article.price_pence,
            hasVaultKey,
          },
          "Gate pass refused: paywalled article misconfigured (missing vault key or invalid price)",
        );
        return { kind: "misconfigured" };
      }
    }

    // Step 2: Free-access fast path
    const access = await checkArticleAccess(
      readerId,
      article.id,
      article.writer_id,
      article.publication_id,
    );
    if (access.hasAccess) {
      if (access.reason === "subscription" && access.subscriptionId) {
        await recordSubscriptionRead(
          readerId,
          article.id,
          article.writer_id,
          access.subscriptionId,
        );
      }

      const keyResult = await fetchContentKey(
        nostrEventId,
        readerId,
        readerPubkey,
      );
      if (!keyResult.ok) {
        return { kind: "service_error" };
      }

      return {
        kind: "success",
        body: {
          readEventId: null,
          readState: access.reason ?? "unknown",
          encryptedKey: keyResult.body.encryptedKey,
          algorithm: keyResult.body.algorithm,
          isReissuance: access.reason === "already_unlocked",
          ciphertext: keyResult.body.ciphertext ?? undefined,
        },
      };
    }

    // Step 3: Invitation-only — no purchase path
    if (article.access_mode === "invitation_only") {
      return { kind: "invitation_required" };
    }

    // Step 4: Get-or-create reader's tab + compute pubkey hash
    const tabId = await getOrCreateTab(readerId);
    const readerPubkeyHash = createHmac("sha256", READER_HASH_KEY)
      .update(readerPubkey)
      .digest("hex");

    // Step 5: Charge via payment service
    const paymentRes = await fetch(`${PAYMENT_SERVICE_URL}/api/v1/gate-pass`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": INTERNAL_SERVICE_TOKEN,
      },
      // A hung payment service must not hang every unlock. On timeout the
      // charge may or may not have committed — that ambiguity is safe: the
      // payment service's gate-pass is idempotent per (reader, article) (F7),
      // so the reader's retry either finds the committed read or charges once.
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        readerId,
        articleId: article.id,
        writerId: article.writer_id,
        amountPence: article.price_pence,
        readerPubkey,
        readerPubkeyHash,
        tabId,
        publicationId: article.publication_id,
      }),
    });

    if (!paymentRes.ok) {
      const body = (await paymentRes.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (paymentRes.status === 402) {
        return {
          kind: "payment_required",
          error: body?.error ?? "payment_required",
        };
      }
      logger.error(
        { status: paymentRes.status, body },
        "Payment service gate-pass failed",
      );
      return { kind: "service_error" };
    }

    const paymentResult = (await paymentRes.json()) as {
      readEventId: string | null;
      state: string;
      allowanceJustExhausted?: boolean;
    };

    // Step 6: Persist unlock immediately so a retry after key-issuance failure
    // hits checkArticleAccess → 'already_unlocked' and skips re-charging.
    // F3: a provisional (card-less) read's unlock is marked non-permanent.
    await recordPurchaseUnlock(
      readerId,
      article.id,
      paymentResult.state === "provisional",
    );

    // Step 7: Issue content key
    const keyResult = await fetchContentKey(
      nostrEventId,
      readerId,
      readerPubkey,
    );
    if (!keyResult.ok) {
      logger.error(
        {
          status: keyResult.status,
          body: keyResult.body,
          readerId,
          nostrEventId,
        },
        "Key service issuance failed after gate pass",
      );
      return {
        kind: "key_issuance_failed_after_payment",
        readEventId: paymentResult.readEventId,
      };
    }

    logger.info(
      { readerId, nostrEventId, readEventId: paymentResult.readEventId },
      "Gate pass complete — key issued",
    );

    return {
      kind: "success",
      body: {
        readEventId: paymentResult.readEventId,
        readState: paymentResult.state,
        encryptedKey: keyResult.body.encryptedKey,
        algorithm: keyResult.body.algorithm,
        isReissuance: keyResult.body.isReissuance,
        allowanceJustExhausted: paymentResult.allowanceJustExhausted ?? false,
        ciphertext: keyResult.body.ciphertext ?? undefined,
      },
    };
  } catch (err: unknown) {
    if (isNetworkError(err)) {
      logger.error(
        { err, readerId, nostrEventId },
        "Gate pass: upstream service unreachable",
      );
      return { kind: "service_unreachable" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept private to this module
// ---------------------------------------------------------------------------

interface KeyServiceBody {
  encryptedKey: unknown;
  algorithm: unknown;
  isReissuance: boolean;
  ciphertext?: unknown;
}

type KeyServiceFetchResult =
  | { ok: true; body: KeyServiceBody }
  | { ok: false; status: number; body: unknown };

async function fetchContentKey(
  nostrEventId: string,
  readerId: string,
  readerPubkey: string,
): Promise<KeyServiceFetchResult> {
  const res = await fetch(
    `${KEY_SERVICE_URL}/api/v1/articles/${nostrEventId}/key`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
        "x-reader-id": readerId,
        "x-reader-pubkey": readerPubkey,
      },
      // Timeout after payment is safe: the unlock row is already persisted,
      // so the reader's retry re-issues the key without re-charging.
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({}),
    },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: false, status: res.status, body };
  }

  const body = (await res.json()) as KeyServiceBody;
  return { ok: true, body };
}

async function getOrCreateTab(readerId: string): Promise<string> {
  let tabRow = await pool.query<{ id: string }>(
    "SELECT id FROM reading_tabs WHERE reader_id = $1",
    [readerId],
  );
  if (tabRow.rows.length > 0) return tabRow.rows[0].id;

  tabRow = await pool.query<{ id: string }>(
    `INSERT INTO reading_tabs (reader_id)
     VALUES ($1)
     ON CONFLICT (reader_id) DO NOTHING
     RETURNING id`,
    [readerId],
  );
  if (tabRow.rows.length > 0) return tabRow.rows[0].id;

  // Race: another request inserted the tab between our SELECT and INSERT.
  // Re-select to pick up its id.
  tabRow = await pool.query<{ id: string }>(
    "SELECT id FROM reading_tabs WHERE reader_id = $1",
    [readerId],
  );
  return tabRow.rows[0].id;
}

function isNetworkError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: string;
    message?: string;
    cause?: { code?: string };
  };
  const name = (err as { name?: string }).name;
  return (
    e.cause?.code === "ECONNREFUSED" ||
    e.cause?.code === "ENOTFOUND" ||
    e.code === "ECONNREFUSED" ||
    // AbortSignal.timeout fires TimeoutError (AbortError on some runtimes) —
    // an unresponsive upstream is "unreachable", not an internal error.
    name === "TimeoutError" ||
    name === "AbortError" ||
    (typeof e.message === "string" && e.message.includes("fetch failed"))
  );
}
