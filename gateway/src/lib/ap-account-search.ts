import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// ActivityPub account search — discovery branch 6 (RESOLVER-DISCOVERY-ADR §5).
//
// Turns a free-text name into candidate fediverse accounts. Behind a provider
// interface as the FASP hedge: v1 queries Mastodon instances' unauthenticated
// `/api/v2/search` (free since Mastodon 4.0 — no `resolve`, which nomination-
// not-resolution makes unnecessary: webfinger happens once, at pick time, via
// addSource's acct handling). A future FaspAccountSearchProvider (Fediscovery
// `account_search`) slots in with no resolver changes once one clears the
// §5.1 adoption bar.
//
// Consent posture (ADR §8): submit-only, min query length 3, capped, results
// live only in resolver_async_results — never persisted as profiles; we read
// what each instance's own policy already serves, no scraping around it.
// =============================================================================

export interface ApAccountCandidate {
  acct: string; // canonical user@domain (always domain-qualified)
  displayName?: string;
  avatar?: string;
  note?: string; // plain-texted bio excerpt
  url?: string; // actor URI (Account.uri) when reported, else profile URL
}

export interface ApAccountSearchProvider {
  readonly id: string; // 'mastodon_instances' | 'fasp' | …
  search(query: string, limit: number): Promise<ApAccountCandidate[]>;
}

const DEFAULT_INSTANCE = "mastodon.social";
const SEARCH_TIMEOUT_MS = 5_000;

// Instances from env, parsed per call so a config change doesn't need a
// restart-ordering dance. One or at most two recommended — each is a full
// extra HTTP round-trip per discovery submit (see DEPLOYMENT.md).
function discoveryInstances(): string[] {
  const env = process.env.MASTODON_DISCOVERY_INSTANCES;
  return [
    ...new Set(
      (env ?? DEFAULT_INSTANCE)
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

// Good-citizen guards (ADR §5.2): unauthenticated search on big instances is
// IP-rate-limited (~300 req/5 min). Our submit-only volume is far below that,
// but memo each (instance, query) for 5 minutes — mirroring the well-known-RSS
// memo in resolver.ts — so repeated submits (and immediate retries after a
// 429/5xx, which memo an empty result) don't re-hit the instance.
const MEMO_TTL_MS = 5 * 60_000;
const MEMO_MAX = 500;
const memo = new Map<
  string,
  { expires: number; result: ApAccountCandidate[] }
>();

// Test seam — the memo is module-level state.
export function clearApAccountSearchMemo(): void {
  memo.clear();
}

// Per-instance concurrency of 1: chain each instance's searches behind a tail
// promise so concurrent discovery submits queue rather than burst.
const instanceQueue = new Map<string, Promise<unknown>>();

function withInstanceQueue<T>(
  host: string,
  work: () => Promise<T>,
): Promise<T> {
  const tail = instanceQueue.get(host) ?? Promise.resolve();
  const next = tail.then(work, work);
  instanceQueue.set(
    host,
    next.catch(() => {}),
  );
  return next;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchInstance(
  host: string,
  query: string,
  limit: number,
): Promise<ApAccountCandidate[]> {
  const key = `${host} ${query.toLowerCase()}`;
  const cached = memo.get(key);
  if (cached && cached.expires > Date.now()) {
    memo.delete(key);
    memo.set(key, cached);
    return cached.result;
  }

  // Fail-soft to [] on any error/non-OK (per-branch isolation, same as every
  // other discovery chain) — and memo the empty result so an unhealthy
  // instance isn't immediately re-hit.
  const result: ApAccountCandidate[] = [];
  try {
    const res = await safeFetch(
      `https://${host}/api/v2/search?q=${encodeURIComponent(query)}&type=accounts&limit=${limit}`,
      {
        headers: { Accept: "application/json" },
        timeout: SEARCH_TIMEOUT_MS,
      },
    );
    if (res.ok) {
      const body = JSON.parse(res.text);
      const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
      for (const a of accounts) {
        if (!a || typeof a.acct !== "string" || !a.acct) continue;
        // Mastodon returns `acct` WITHOUT a domain for accounts local to the
        // queried instance — append the host so every candidate is user@domain.
        const acct = a.acct.includes("@") ? a.acct : `${a.acct}@${host}`;
        const note =
          typeof a.note === "string" && a.note
            ? stripTags(a.note).slice(0, 280)
            : "";
        result.push({
          acct,
          displayName:
            typeof a.display_name === "string" && a.display_name
              ? a.display_name
              : undefined,
          avatar: typeof a.avatar === "string" && a.avatar ? a.avatar : undefined,
          note: note || undefined,
          // Account.uri is the ActivityPub actor identifier — the same
          // key-space as known-world stable_handle, so the merge step can
          // dedupe against Phase A hits. Fall back to the profile URL.
          url:
            typeof a.uri === "string" && a.uri
              ? a.uri
              : typeof a.url === "string" && a.url
                ? a.url
                : undefined,
        });
      }
    } else {
      logger.warn(
        { host, status: res.status },
        "AP account search returned non-OK",
      );
    }
  } catch (err) {
    logger.warn({ host, err }, "AP account search failed");
  }

  memo.set(key, { expires: Date.now() + MEMO_TTL_MS, result });
  if (memo.size > MEMO_MAX) {
    const firstKey = memo.keys().next().value;
    if (firstKey) memo.delete(firstKey);
  }
  return result;
}

export const mastodonInstanceSearchProvider: ApAccountSearchProvider = {
  id: "mastodon_instances",
  async search(query, limit) {
    const q = query.trim();
    // Same minimum as the known-world index (ADR §8): 1–2 char lookups are
    // noise and not worth a remote fan-out.
    if (q.length < 3) return [];

    const perInstance = await Promise.all(
      discoveryInstances().map((host) =>
        withInstanceQueue(host, () => searchInstance(host, q, limit)),
      ),
    );

    // Dedupe across instances by lowercased canonical acct; first instance
    // listed wins (its metadata is as good as any).
    const seen = new Set<string>();
    const out: ApAccountCandidate[] = [];
    for (const candidates of perInstance) {
      for (const c of candidates) {
        const key = c.acct.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
    return out.slice(0, limit);
  },
};

// Provider chosen by config — v1 ships Mastodon-instances only. When a
// production-quality FASP provider exists (§5.1 adoption bar), branch here on
// an env selector; the resolver registers against the interface and needs no
// change.
export function getApAccountSearchProvider(): ApAccountSearchProvider {
  return mastodonInstanceSearchProvider;
}

export async function searchApAccounts(
  query: string,
  limit = 5,
): Promise<ApAccountCandidate[]> {
  return getApAccountSearchProvider().search(query, limit);
}
