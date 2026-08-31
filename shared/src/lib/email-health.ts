import logger from "../lib/logger.js";
import { safeFetch } from "./http-client.js";

// =============================================================================
// email-health — the platform proves the credential it sends every email with,
// and counts the sends that fail.
//
// THE BUG THIS EXISTS TO END (found on prod 2026-08-11, CONSOLIDATED-TODO §0r).
// The Postmark server token in `gateway/.env` was rotated, revoked or replaced
// with an Account token; Postmark answered 401 (ErrorCode 10) to every send. For
// up to SEVENTEEN DAYS every outbound email failed — magic links for all nine
// accounts, publish notifications to subscribers, the waitlist digest — and
// nothing anywhere said so. `auth.ts` catches the send error and still returns
// 200, deliberately, so a delivery failure cannot be used to probe whether an
// account exists; that anti-enumeration choice is correct and is also exactly
// what made this invisible from the outside. It was found sideways, by an
// operator who happened to be logging into a test account for another reason.
//
// The general rule it produced: WHEN A CATCH BLOCK EXISTS SO THAT A FAILURE DOES
// NOT BREAK THE REQUEST, SOMETHING ELSE MUST CARRY THE FACT THAT IT FAILED. This
// module is that something else.
//
// THE SHAPE IS `internal-parity.ts`'s, deliberately, because it is the same
// class of dependency — a credential held in an env file, used against a service
// that answers a definitive rejection when it is wrong:
//
//   * PROVE it rather than assume it: probe an endpoint that authenticates with
//     the same token, at boot and periodically. Reaching it IS the proof; no
//     hash or fingerprint of the token is exchanged, because the vendor's own
//     guard already answers the question.
//   * TERMINAL vs AMBIGUOUS: a 401/403 is a deterministic rejection and is
//     acted on; a timeout, a 5xx or a DNS failure might be transient and is not.
//     The same split as the Stripe classifiers and the parity probe.
//   * STICKY BOTH WAYS: only a definitive verdict overwrites a definitive
//     verdict, so an unreachable Postmark does not erase a proven mismatch and a
//     nightly network blip does not make the signal flap.
//
// WHAT IS DELIBERATELY DIFFERENT FROM PARITY, IN BOTH DIRECTIONS:
//
//   * NEVER FATAL. A drifted internal secret can only be introduced at a deploy,
//     with an operator watching, so the gateway exits on one. Email is a
//     third-party credential that can be revoked at 3am by someone else's
//     billing system, and a gateway that kills itself then would take down all
//     free reading, auth and feeds over an email fault. It reports; it never
//     exits.
//   * THE SENDS THEMSELVES ARE EVIDENCE. A peer probe is the only proof parity
//     can get. Here, every real send is a live test of the same credential, so a
//     200 from a send PROVES the token and a 401 from a send DISPROVES it —
//     stronger and earlier than any probe interval. `notePostmarkResponse` is
//     that path, and it is why the incident would have been caught by the first
//     magic link rather than at the next tick.
//   * A COUNT WITH ITS DENOMINATOR. The probe answers "is the credential good";
//     it cannot answer "are emails going out" — an unconfirmed sender signature,
//     a rate limit, a suppressed recipient and an inactive server all reject a
//     send while the token stays valid. So sends are counted, and both numbers
//     ship: `failed: 0, attempted: 0` means NOTHING WAS SENT, which is a
//     different fact from a healthy send path and must never render as one (the
//     empty-denominator rule the allocation reconciler states for rates).
//
// WHAT THIS CANNOT SEE, stated so nobody reads more into it than is there. The
// counts are in-process and reset on restart, so they describe this boot only —
// the report says so, in words. And Postmark accepting a message is not delivery
// to a human: a bounce, a spam fold or a suppression happens after the API call
// has already returned 200. The credential is what this proves.
// =============================================================================

/**
 * What a probe (or a send's own response) proves about the credential.
 *
 * `not_probeable` is a real answer, not a failure: only Postmark is probed (see
 * `probeEmailCredential`), so for any other provider this module reports that it
 * has checked nothing rather than implying an all-clear.
 */
export type EmailProbeVerdict =
  /** 200 — the credential is good. */
  | "valid"
  /** 401/403 — the provider rejected it. Terminal; retrying cannot change it. */
  | "invalid"
  /** Timeout, DNS, 5xx, anything indefinite. Ambiguous; retry, never act. */
  | "unreachable"
  /** This provider has no credential probe here. Never an all-clear. */
  | "not_probeable";

/**
 * Postmark's server-configuration endpoint. It authenticates with the same
 * `X-Postmark-Server-Token` a send does, and returns the server's own settings —
 * so reaching it proves the token is a valid SERVER token for a live server,
 * which is the exact thing the incident's token was not. It sends no mail and
 * changes nothing.
 */
const POSTMARK_PROBE_URL = "https://api.postmarkapp.com/server";

const PROBE_TIMEOUT_MS = 8_000;

/**
 * Classify Postmark's answer to the probe.
 *
 * **401 IS THE ONE THAT MATTERS, AND 403 IS INCLUDED FOR THE SAME REASON THE
 * PARITY CLASSIFIER INCLUDES BOTH.** Postmark returns 401 with `ErrorCode: 10`
 * for a missing, wrong, revoked or wrong-KIND token (an Account token pasted
 * where a Server token belongs is the same 10), which is what prod had. Writing
 * the classifier for the status one incident happened to produce is how a
 * checker passes every test anyone thinks to write and still never fires.
 *
 * **404 IS NOT TERMINAL HERE**, unlike nothing in particular — it would mean
 * Postmark moved the endpoint under us, which is an ambiguous fact about our
 * probe rather than a proven fact about the token, and acting on it would raise
 * a credential alarm for a vendor's API change.
 *
 * **422 IS AMBIGUOUS.** Postmark uses it for API-level errors carrying their own
 * ErrorCode; on a GET of the server's own configuration it should not occur at
 * all, and treating an unexplained 422 as proof the token is bad would put a
 * red banner up on the strength of a guess.
 */
export function classifyPostmarkProbeStatus(status: number): EmailProbeVerdict {
  if (status >= 200 && status < 300) return "valid";
  if (status === 401 || status === 403) return "invalid";
  return "unreachable";
}

// -----------------------------------------------------------------------------
// State
//
// All of it in process memory, like the parity module's: this is read by an
// admin page served BY this process, so a gateway that is gone renders no page
// at all rather than a reassuring one. Nothing here belongs in `platform_config`
// — runtime state written to that table is the `jetstream_healthy` shape the
// liveness invariant exists to forbid.
// -----------------------------------------------------------------------------

/** `true` proven valid, `false` proven rejected, `null` never proven either way. */
let credential: boolean | null = null;
/** When the last DEFINITIVE verdict was reached — not when we last tried. */
let credentialAt: Date | null = null;
/** One sentence naming what was proven, for the operator's banner. */
let credentialDetail: string | null = null;

let bootAt = new Date();
let attempted = 0;
let failed = 0;
let lastFailureAt: Date | null = null;
let lastError: string | null = null;

let probeTimer: NodeJS.Timeout | null = null;

export interface EmailHealthReport {
  /** `EMAIL_PROVIDER` as this process sees it. `console` means nothing is sent. */
  provider: string;
  /** Whether the provider above has a credential probe here at all. */
  probeSupported: boolean;
  /**
   * The last DEFINITIVE verdict. `null` is NEVER CONFIRMED — a third state, and
   * not the same as fine.
   */
  credential: "valid" | "invalid" | null;
  credentialCheckedAt: string | null;
  credentialDetail: string | null;
  /** Sends are counted from here. Process memory: a restart resets them. */
  sinceBootAt: string;
  /** The denominator. Zero attempts means nothing was sent, not nothing failed. */
  attempted: number;
  failed: number;
  lastFailureAt: string | null;
  lastError: string | null;
}

export function getEmailHealth(): EmailHealthReport {
  const provider = process.env.EMAIL_PROVIDER ?? "console";
  return {
    provider,
    probeSupported: provider === "postmark",
    credential: credential === null ? null : credential ? "valid" : "invalid",
    credentialCheckedAt: credentialAt ? credentialAt.toISOString() : null,
    credentialDetail,
    sinceBootAt: bootAt.toISOString(),
    attempted,
    failed,
    lastFailureAt: lastFailureAt ? lastFailureAt.toISOString() : null,
    lastError,
  };
}

/** Test seam — reset the module's memory between cases. */
export function __resetEmailHealth(): void {
  credential = null;
  credentialAt = null;
  credentialDetail = null;
  bootAt = new Date();
  attempted = 0;
  failed = 0;
  lastFailureAt = null;
  lastError = null;
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = null;
}

/**
 * Record a DEFINITIVE verdict, from a probe or from a real send's own response.
 *
 * Logs on TRANSITION only, for the parity module's reason: a warning every
 * fifteen minutes is a warning an operator learns to scroll past, and the
 * original incident survived seventeen days inside a log nobody had reason to
 * grep. `firstProof` is kept distinct for the same reason it is there — "the
 * credential has been broken since boot and we could not see it" and "someone
 * rotated it just now" send an operator to look in different places.
 */
export function recordCredentialEvidence(
  verdict: "valid" | "invalid",
  detail: string,
): void {
  const now = verdict === "valid";
  const before = credential;
  credential = now;
  credentialAt = new Date();
  credentialDetail = detail;
  if (before === now) return;

  const firstProof = before === null;
  if (now) {
    logger.warn(
      { firstProof, detail },
      firstProof
        ? "Email credential CONFIRMED for the first time since boot — outbound email is authenticating"
        : "Email credential RESTORED — outbound email is authenticating again",
    );
  } else {
    logger.error(
      { firstProof, detail },
      "EMAIL CREDENTIAL REJECTED — the provider is refusing our API token, so EVERY outbound email is failing: magic links (so nobody can log in), publish notifications and the waitlist digest. Nothing else reports this: the login route swallows the send error by design and still answers 200. NOT exiting — an email fault must not take down reading and auth. Fix the token in gateway/.env and RECREATE the container (restart does not reload env_file), then watch /admin/overview",
    );
  }
}

/**
 * Probe the configured provider's credential once.
 *
 * ONLY POSTMARK IS PROBED, and the alternative was worse than the gap. Resend's
 * closest endpoint (`GET /api-keys`) needs a full-access key, so a correctly
 * configured send-only key would answer 401 and this module would raise a
 * credential alarm about a credential that works — a false alarm on the one
 * surface built to be believed. `not_probeable` says plainly that nothing was
 * checked, and the send counter still covers that provider.
 */
export async function probeEmailCredential(): Promise<EmailProbeVerdict> {
  const provider = process.env.EMAIL_PROVIDER ?? "console";
  if (provider !== "postmark") return "not_probeable";

  const apiKey = process.env.POSTMARK_API_KEY;
  if (!apiKey) {
    // Definitive, and it needs no network: `sendViaPostmark` throws before it
    // fetches, so every send is already failing. Reported as a rejected
    // credential because that is what it is from the platform's side, with the
    // detail naming the different fix.
    recordCredentialEvidence(
      "invalid",
      "POSTMARK_API_KEY is not set, so no email can be sent at all.",
    );
    return "invalid";
  }

  let status: number;
  let body: string;
  try {
    const res = await safeFetch(POSTMARK_PROBE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Postmark-Server-Token": apiKey,
      },
      timeout: PROBE_TIMEOUT_MS,
    });
    status = res.status;
    body = res.text;
  } catch {
    // No answer at all — DNS, refused, timed out. Never terminal, and it leaves
    // whatever was last proven exactly as it was.
    return "unreachable";
  }

  const verdict = classifyPostmarkProbeStatus(status);
  if (verdict === "valid") {
    recordCredentialEvidence("valid", "Postmark accepted the server token.");
  } else if (verdict === "invalid") {
    recordCredentialEvidence(
      "invalid",
      `Postmark rejected the server token with HTTP ${status}. ${summarisePostmarkError(body)}`,
    );
  }
  return verdict;
}

/**
 * Postmark's error body, cut to a sentence an operator can act on.
 *
 * ErrorCode 10 is the incident's own code and covers both a wrong token and an
 * Account token used where a Server token belongs, which is why the message is
 * carried through verbatim rather than restated.
 */
function summarisePostmarkError(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { ErrorCode?: number; Message?: string };
    if (parsed && typeof parsed.Message === "string") {
      const code = typeof parsed.ErrorCode === "number" ? `ErrorCode ${parsed.ErrorCode}: ` : "";
      return `${code}${parsed.Message}`.slice(0, 200);
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return trimmed.slice(0, 200);
}

/**
 * A real Postmark send's own response, fed back as credential evidence.
 *
 * This is the earliest possible detection and it costs nothing: the first magic
 * link after a token is revoked proves the token is dead, fifteen minutes before
 * the next probe would. Called by both Postmark send paths, on success and on
 * failure alike — a 200 is as much proof as a 401.
 *
 * Ambiguous statuses (429, 5xx) are deliberately ignored rather than recorded as
 * anything: a rate limit is a real send failure, which the counter carries, and
 * is not a fact about the credential.
 */
export function notePostmarkResponse(status: number, body?: string): void {
  const verdict = classifyPostmarkProbeStatus(status);
  if (verdict === "valid") {
    recordCredentialEvidence("valid", "Postmark accepted a real send.");
  } else if (verdict === "invalid") {
    recordCredentialEvidence(
      "invalid",
      `Postmark rejected a real send with HTTP ${status}. ${summarisePostmarkError(body ?? "")}`,
    );
  }
}

/**
 * Wrap a send so its outcome is counted whatever else happens to it.
 *
 * The counter is the half of this module that does not depend on knowing the
 * provider: a valid token still fails on an unconfirmed sender signature, a rate
 * limit, a suppressed recipient or an inactive server, and the operator's
 * question is "is mail going out", not "is the token good". Rethrows always —
 * callers decide what a failure means for their request, and several of them
 * deliberately swallow it.
 */
export async function trackSend<T>(send: () => Promise<T>): Promise<T> {
  attempted++;
  try {
    return await send();
  } catch (err) {
    failed++;
    lastFailureAt = new Date();
    lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Boot + periodic probe
// -----------------------------------------------------------------------------

/**
 * Ambiguous-only retry ladder at boot. Containers start with the network not
 * quite up, and leaving "never confirmed" on the admin page for a quarter of an
 * hour after every deploy is how a real signal gets learned past.
 */
const BOOT_RETRY_DELAYS_MS = [3_000, 15_000, 60_000];

/**
 * Fifteen minutes, where parity re-probes at five. A shared secret changes when
 * an operator edits an env file; a vendor credential is revoked rarely and by
 * someone else. This is also a third party's API rather than a container on the
 * same network, and every real send already reports in between (see
 * `notePostmarkResponse`), so the interval is a floor, not the detector.
 */
const REPROBE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Prove the email credential and keep proving it. Never throws, never exits.
 *
 * Runs AFTER the caller is listening, like the parity check, so nothing about
 * serving pages waits on a third party's API.
 */
export async function startEmailHealthChecks(
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? "console";
  if (provider !== "postmark") {
    // Not a fault and not an all-clear. `console` in production would mean every
    // email is being written to a log instead of sent, which is the incident's
    // own failure mode by a different route — so it is said out loud here and
    // rendered on the admin overview, rather than left to be inferred.
    logger.info(
      { provider },
      provider === "console"
        ? "Email credential NOT CHECKED — EMAIL_PROVIDER is `console`, so nothing is being emailed at all (expected in dev; in production this means every magic link is going to a log file)"
        : "Email credential NOT CHECKED — no probe exists for this EMAIL_PROVIDER, so a revoked credential here would only show as failed sends",
    );
    return;
  }

  for (let attempt = 0; ; attempt++) {
    const verdict = await probeEmailCredential();
    if (verdict !== "unreachable") break;
    if (attempt >= BOOT_RETRY_DELAYS_MS.length) {
      logger.warn(
        { attempts: attempt + 1 },
        "Email credential NEVER CONFIRMED at boot — Postmark did not answer the probe. Not a rejection: the token may be fine. The periodic probe keeps trying, and /admin/overview reports this as unconfirmed rather than as healthy",
      );
      break;
    }
    await sleep(BOOT_RETRY_DELAYS_MS[attempt]);
  }

  if (probeTimer) clearInterval(probeTimer);
  probeTimer = setInterval(() => void probeEmailCredential(), REPROBE_INTERVAL_MS);
  // Never hold the process open for a health check.
  probeTimer.unref?.();
}
