import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// internal-parity — the gateway proves, at boot, that it holds the same shared
// secrets as the services it calls.
//
// THE BUG THIS EXISTS TO END (found on prod 2026-08-07). `INTERNAL_SERVICE_TOKEN`
// differed between `gateway/.env` and `payment-service/.env`. The payment
// service answered 403 to everything the gateway proxied — including
// `/gate-pass`, which is the paywall — so EVERY paywalled unlock failed while
// the site looked entirely healthy. Nothing detected it. It surfaced only
// because a new admin panel happened to proxy on a page load rather than behind
// a button, and even then it took three rounds to identify, because the gateway
// passed the upstream status to the browser without logging it.
//
// A drifted shared secret is the worst shape a config error can take: it is
// silent, it is total for the paths it touches, and it looks like nothing. The
// fix is one line in one file — the cost is entirely in NOT KNOWING.
//
// TWO SECRETS, THREE PEERS. `INTERNAL_SECRET` (gateway → key-custody,
// key-service) has the wider surface of the two and breaks publishing, key
// issuance and paywalled delivery; `INTERNAL_SERVICE_TOKEN` (gateway → payment)
// breaks the money paths. Both are checked, because building this for only the
// one that happened to bite would leave the larger hole open.
//
// HOW THE PROOF WORKS. Each peer exposes `GET /api/v1/auth-check` behind ITS OWN
// existing internal guard. Reaching the handler proves the caller's secret
// matches the verifier's, so a 200 IS the parity proof — no hash, fingerprint or
// length is exchanged, because the guard already answers the question and an
// echoed digest would be a disclosure surface bought for nothing.
//
// WHY THIS DOES NOT BLOCK `listen()`. The gateway serves all free reading, auth
// and feeds; coupling its availability to a money or key service being up at
// startup would be a worse bug than the one being fixed. So the probe runs
// AFTER the gateway is listening and its own healthcheck can pass, and only a
// DEFINITIVE mismatch is ever acted on.
// =============================================================================

/**
 * What a peer's answer proves. The terminal/ambiguous split is the same
 * discipline `payment-service/src/lib/charge-errors.ts` applies to Stripe: a
 * deterministic rejection that will never succeed on retry is a different fact
 * from a failure that might be transient, and conflating them is how you either
 * ignore a real fault or act on a blip.
 */
export type ParityVerdict =
  /** 200 — the secrets match. */
  | "match"
  /** 401/403 — they provably differ. Terminal; retrying cannot change it. */
  | "mismatch"
  /** 404 — peer predates the probe endpoint. Not a mismatch. */
  | "no_endpoint"
  /** Anything else, including no response at all. Ambiguous; retry. */
  | "unreachable";

/**
 * Classify a peer's HTTP status.
 *
 * **401 AND 403 ARE BOTH TERMINAL, AND THIS WAS MEASURED, NOT ASSUMED.** The
 * three peers disagree about which they return: `payment-service`'s
 * `requireInternalToken` sends **403**, while `key-service`'s plugin-scope
 * preHandler and `key-custody`'s `requireInternalSecret` both send **401**. A
 * classifier written for 403 alone — the status of the incident that prompted
 * this — would silently never detect an `INTERNAL_SECRET` drift at all, which is
 * the wider of the two surfaces. It would also pass every test anyone thought to
 * write, because the one failure they had in mind was the payment one.
 *
 * **404 is NOT a mismatch.** A peer running an older image has no `/auth-check`,
 * and treating that as a definitive failure would crash-loop the gateway during
 * any partial deploy — turning a routine version skew into an outage. Reported
 * distinctly because "old peer" and "peer is down" want different responses.
 *
 * **503 is ambiguous, not terminal.** It is what `key-custody` returns when its
 * OWN secret is unset. That would be a fatal config error, but it is the peer's
 * to report — and in practice unreachable, since all three peers `requireEnv`
 * their secret and refuse to boot without it.
 */
export function classifyParityStatus(status: number): ParityVerdict {
  if (status === 200) return "match";
  if (status === 401 || status === 403) return "mismatch";
  if (status === 404) return "no_endpoint";
  return "unreachable";
}

export interface ParityPeer {
  /** Name as it appears in logs. */
  name: string;
  /** Base URL env var, e.g. PAYMENT_SERVICE_URL. */
  urlEnv: string;
  /** The header this peer authenticates on. */
  header: string;
  /** The env var holding the shared secret, e.g. INTERNAL_SECRET. */
  secretEnv: string;
}

export const PARITY_PEERS: ParityPeer[] = [
  {
    name: "payment-service",
    urlEnv: "PAYMENT_SERVICE_URL",
    header: "x-internal-token",
    secretEnv: "INTERNAL_SERVICE_TOKEN",
  },
  {
    name: "key-custody",
    urlEnv: "KEY_CUSTODY_URL",
    header: "x-internal-secret",
    secretEnv: "INTERNAL_SECRET",
  },
  {
    name: "key-service",
    urlEnv: "KEY_SERVICE_URL",
    header: "x-internal-secret",
    secretEnv: "INTERNAL_SECRET",
  },
];

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Backoff between ambiguous retries, in ms, and the number of attempts. Peers
 * start alongside the gateway, so the early attempts are expected to miss; the
 * window is generous enough to outlast an ordinary compose start and bounded so
 * a peer that never comes up produces one clear report rather than a log that
 * grows forever.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000];

async function probeOnce(peer: ParityPeer, baseUrl: string, secret: string): Promise<ParityVerdict> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/auth-check`, {
      method: "GET",
      headers: { [peer.header]: secret },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return classifyParityStatus(res.status);
  } catch {
    // No response at all — refused, timed out, DNS. Never terminal.
    return "unreachable";
  }
}

/**
 * Probe one peer until it gives a definitive answer or the retry window closes.
 *
 * Resolves `true` when parity is PROVEN, `false` when it is provably broken, and
 * `null` when we never got a definitive answer. The three are deliberately
 * distinct: "never confirmed" must not be reported as "fine", which is the whole
 * failure mode this module exists to end, one level up.
 */
export async function verifyPeerParity(
  peer: ParityPeer,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean | null> {
  const baseUrl = process.env[peer.urlEnv];
  const secret = process.env[peer.secretEnv];

  if (!baseUrl || !secret) {
    // Not this module's failure to raise: the callers of that peer already
    // requireEnv what they need, and inventing a second boot-time gate here
    // would fail the gateway for a reason unrelated to parity.
    logger.warn(
      { peer: peer.name, urlEnv: peer.urlEnv, secretEnv: peer.secretEnv },
      "Internal parity: peer URL or secret not configured — parity NOT verified for this peer",
    );
    return null;
  }

  for (let attempt = 0; ; attempt++) {
    const verdict = await probeOnce(peer, baseUrl, secret);

    if (verdict === "match") {
      logger.info({ peer: peer.name, secretEnv: peer.secretEnv }, "Internal parity: confirmed");
      return true;
    }
    if (verdict === "mismatch") return false;

    if (attempt >= RETRY_DELAYS_MS.length) {
      logger.error(
        { peer: peer.name, secretEnv: peer.secretEnv, verdict, attempts: attempt + 1 },
        verdict === "no_endpoint"
          ? "Internal parity: peer has no /auth-check — an older image? Parity was NEVER VERIFIED for this peer; a drifted secret here would be silent"
          : "Internal parity: peer never answered. Parity was NEVER VERIFIED for this peer; a drifted secret here would be silent",
      );
      return null;
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

// -----------------------------------------------------------------------------
// Slice 2 — the runtime re-probe
//
// The boot check only fires when the GATEWAY restarts. `docker compose up -d
// payment` on its own recreates a peer with whatever secret its .env now holds,
// while this process keeps running against a peer it no longer matches — the
// original silent failure, reachable without ever touching the gateway.
//
// WHY THIS ONE IS NOT FATAL, WHERE THE BOOT CHECK IS. The asymmetry is
// deliberate, not an oversight. A boot mismatch can only be introduced by a
// deploy, i.e. with an operator present and watching, so exiting costs a minute
// and cannot be missed. A RUNTIME mismatch can appear at three in the morning
// when a peer is redeployed alone — and a gateway that kills itself then would
// take down all free reading, auth and feeds, converting a partial money outage
// into a total site outage with nobody there to fix it. So runtime drift is made
// LOUD in three places and fatal in none.
// -----------------------------------------------------------------------------

/** How often the runtime re-probe runs. Three cheap requests; rare condition. */
const REPROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The last DEFINITIVE verdict per peer — `true` proven match, `false` proven
 * mismatch, `null` never proven either way.
 *
 * Ambiguity does not overwrite it. A peer that is briefly down must not erase a
 * proven match (that would make the health signal flap with peer restarts), and
 * a proven mismatch stays until a later probe proves otherwise, because it is
 * sticky until someone fixes the env.
 */
const parityState = new Map<string, boolean | null>();

export interface ParityReport {
  /** False only when a secret PROVABLY differs. Never false for unreachable. */
  ok: boolean;
  /** Peers that answered 401/403 to a probe carrying our secret. */
  mismatched: string[];
  /** Peers parity was never proven for, either way. Not the same as fine. */
  unverified: string[];
}

export function getParityReport(): ParityReport {
  const mismatched: string[] = [];
  const unverified: string[] = [];
  for (const peer of PARITY_PEERS) {
    const verdict = parityState.get(peer.name) ?? null;
    if (verdict === false) mismatched.push(peer.name);
    else if (verdict === null) unverified.push(peer.name);
  }
  return { ok: mismatched.length === 0, mismatched, unverified };
}

/** Test seam — reset the module's memory between cases. */
export function __resetParityState(): void {
  parityState.clear();
}

/**
 * One re-probe round. A single attempt per peer, no retry loop: this runs every
 * few minutes anyway, so a retry here would only blur which probe saw what.
 *
 * Logs on TRANSITION only. Warning on every round would turn the one signal that
 * matters into noise an operator learns to scroll past, which is how the
 * original incident stayed invisible.
 */
export async function reprobeParity(): Promise<void> {
  await Promise.all(
    PARITY_PEERS.map(async (peer) => {
      const baseUrl = process.env[peer.urlEnv];
      const secret = process.env[peer.secretEnv];
      if (!baseUrl || !secret) return;

      const verdict = await probeOnce(peer, baseUrl, secret);
      // Ambiguous: keep whatever we last PROVED. See parityState's note.
      if (verdict === "no_endpoint" || verdict === "unreachable") return;

      const now = verdict === "match";
      const before = parityState.get(peer.name) ?? null;
      parityState.set(peer.name, now);
      if (now === before) return;

      // WHAT THE OPERATOR IS SENT TO LOOK FOR DEPENDS ON WHETHER THERE WAS A
      // PRIOR STATE. `before === null` is the never-confirmed third state (this
      // peer was unreachable, or on a pre-/auth-check image, for every probe
      // since boot) — so this round is the FIRST proof either way, and there is
      // no transition to describe. Saying "RESTORED" claims a break that was
      // never observed; saying "redeployed with a different secret" sends the
      // operator to reconstruct a redeploy that may never have happened, when
      // the likelier truth is that it has been broken the whole time and we
      // could not see it. Same two log levels, honest subjects.
      const firstProof = before === null;
      if (now) {
        logger.warn(
          { peer: peer.name, secretEnv: peer.secretEnv, firstProof },
          firstProof
            ? "Internal parity CONFIRMED for the first time since boot — this peer was never reachable to prove either way before now, and its shared secret matches"
            : "Internal parity RESTORED — this peer's shared secret matches again",
        );
      } else {
        logger.error(
          { peer: peer.name, secretEnv: peer.secretEnv, firstProof },
          firstProof
            ? "SHARED SECRET MISMATCH — first definitive probe of this peer since boot (it was unreachable or on an older image until now), so this may have been broken all along rather than newly introduced. Every call to it fails silently. NOT exiting: that would take the whole site down for a fault in one peer. The gateway's /health is now failing, so `docker compose ps` shows it unhealthy. Fix the env var in both .env files and recreate both containers"
            : "SHARED SECRET MISMATCH APPEARED AT RUNTIME — this peer was redeployed with a different secret, so every call to it now fails silently. NOT exiting: that would take the whole site down for a fault in one peer. The gateway's /health is now failing, so `docker compose ps` shows it unhealthy. Fix the env var in both .env files and recreate both containers",
        );
      }
    }),
  );
}

export function startParityReprobe(): NodeJS.Timeout {
  return setInterval(() => void reprobeParity(), REPROBE_INTERVAL_MS);
}

/**
 * Verify every peer, and REFUSE TO RUN if any secret provably differs.
 *
 * Called after `listen()` so the gateway is already serving — see the module
 * header. The exit is deliberate and was an explicit owner decision (2026-08-07):
 * with `restart: unless-stopped` the gateway will crash-loop, so the site is
 * down until the env is fixed. That is a real cost, accepted because the failure
 * is a one-line config error that can only be introduced at a deploy — when an
 * operator is present and watching — and because the alternative, logging and
 * carrying on, is precisely what allowed a broken paywall to go unnoticed.
 *
 * The exit is reached ONLY from a definitive 401/403. An unreachable or
 * old-image peer never kills the gateway.
 */
export async function assertInternalParity(): Promise<void> {
  const results = await Promise.all(
    PARITY_PEERS.map(async (peer) => ({ peer, ok: await verifyPeerParity(peer) })),
  );

  // Seed the state the health endpoint and the re-probe read from, so an
  // unverified peer at boot is reported as unverified rather than as fine.
  for (const { peer, ok } of results) parityState.set(peer.name, ok);

  const broken = results.filter((r) => r.ok === false).map((r) => r.peer);
  if (broken.length === 0) {
    // Only once the boot check has cleared: the re-probe exists to catch drift
    // introduced AFTER this point, and starting it earlier would race the
    // retry loop above and log a transition for a peer that was merely slow.
    startParityReprobe();
    return;
  }

  logger.fatal(
    {
      peers: broken.map((p) => p.name),
      secrets: [...new Set(broken.map((p) => p.secretEnv))],
    },
    "SHARED SECRET MISMATCH — this gateway holds a different secret from the service(s) named, which answered 401/403 to a probe carrying it. Every call to them will fail, silently, including paywalled unlocks and article publishing. Refusing to start. Fix: make the named env var identical in gateway/.env and that service's .env, then recreate BOTH containers.",
  );
  process.exit(1);
}
