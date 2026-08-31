import {
  bridgeIdentityKeys,
  extractDid,
  isBridgeMirror,
  nativeIdentityKey,
  type BridgeSourceLike,
} from "@platform-pub/shared/lib/bridge-identity.js";

// =============================================================================
// Resolver merge step (RESOLVER-DISCOVERY-ADR §6) — the one function every
// storeAsyncResult write passes through. Three jobs, in order:
//
//   1. Alias dedupe: the same identity reached through two key-spaces (an AP
//      acct vs its actor URI, a candidate re-surfaced by a second branch)
//      collapses to one match; higher confidence wins, ties keep the earlier
//      (already-persisted) candidate so partial-result UX stays stable.
//   2. Bridge-collision drop (§6.1): the same person must not appear as both
//      their native identity and a bridge mirror (Bridgy Fed AP↔atproto,
//      Mostr Nostr↔AP). Where a mirror's decoded origin key collides with a
//      native-protocol candidate in the merged set, the mirror is dropped and
//      the native kept. A mirror with no native twin present survives — it is
//      still a valid way to follow that person.
//   3. Ordering (§6.2, audit F5.4): confidence rank, then context priority,
//      then branch precision as a stable tie-break.
//
// Pure — no I/O, unit-tested in gateway/tests/resolver-merge.test.ts. The
// match-shape types live here (first bite of the §8.5 decomposition after
// nostr-search); resolver.ts re-exports ResolveContext for its callers.
// =============================================================================

export type MatchType = "native_account" | "external_source" | "rss_feed";
export type Confidence = "exact" | "probable" | "speculative";
export type ResolveContext =
  | "subscribe"
  | "invite"
  | "dm"
  | "import"
  | "general";

export interface ResolverMatch {
  type: MatchType;
  confidence: Confidence;
  // --- merge hints (§6.1) — identity aliases the merge step reads to compute
  // dedupe + bridge-collision keys. Additive wire fields: the frontend renders
  // none of them and a pick never re-enters addSource through them.
  /** atproto handle (alice.example.com) / AP acct (user@domain). */
  handle?: string;
  /** AP actor URI when sourceUri is an acct (discovery candidates). */
  actorUrl?: string;
  /** NIP-48 proxy tag off a nostr kind-0 — marks a bridged mirror. */
  proxy?: { origin: string; protocol: string };
  // --- payloads
  account?: {
    id: string;
    username: string;
    displayName: string;
    avatar?: string;
  };
  externalSource?: {
    protocol: "atproto" | "activitypub" | "rss" | "nostr_external";
    sourceUri: string;
    displayName?: string;
    avatar?: string;
    description?: string;
    relayUrls?: string[];
  };
  rssFeed?: {
    feedUrl: string;
    title?: string;
    description?: string;
  };
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  exact: 0,
  probable: 1,
  speculative: 2,
};

// user@domain.tld, optional leading @ (the resolver's FEDIVERSE/AMBIGUOUS_AT
// shape, anchored the same way).
const ACCT_SHAPE = /^@?[\w.+-]+@[\w.-]+\.[\w.]+$/;

const stripAt = (s: string) => s.replace(/^@/, "").toLowerCase();

/**
 * Adapt a match into the shared bridge-identity source shape. For AP the
 * actor URI (when known) is the identity string the bridge hosts are detected
 * on; the acct rides `handle` (falling back to an acct-shaped sourceUri, the
 * discovery-candidate case).
 */
function asBridgeSource(m: ResolverMatch): BridgeSourceLike | null {
  const x = m.externalSource;
  if (!x) return null;
  switch (x.protocol) {
    case "atproto":
      return { protocol: "atproto", source_uri: x.sourceUri, handle: m.handle ?? null };
    case "nostr_external":
      return { protocol: "nostr_external", source_uri: x.sourceUri, handle: null };
    case "activitypub": {
      const acct =
        m.handle ?? (ACCT_SHAPE.test(x.sourceUri) ? x.sourceUri : null);
      return {
        protocol: "activitypub",
        source_uri: m.actorUrl ?? x.sourceUri,
        handle: acct ? stripAt(acct) : null,
      };
    }
    default:
      return null; // rss — never a bridge endpoint
  }
}

/**
 * Every alias key under which this match's identity is known, for dedupe.
 * AP candidates are addressable by both acct and actor URI; everything else
 * has one canonical identity.
 */
function dedupeAliases(m: ResolverMatch): string[] {
  if (m.type === "native_account" && m.account) {
    return [`native:${m.account.id}`];
  }
  if (m.type === "rss_feed" && m.rssFeed) {
    // Same key-space as an external_source rss row: a catalog nomination and a
    // known-world hit for the same feed URL are the same identity (the
    // known-world hit wins on confidence — it's 'probable').
    return [`rss:${m.rssFeed.feedUrl.toLowerCase()}`];
  }
  const x = m.externalSource;
  if (!x) return [];
  const keys = new Set<string>([`${x.protocol}:${x.sourceUri.toLowerCase()}`]);
  if (x.protocol === "activitypub") {
    if (m.actorUrl) keys.add(`activitypub:${m.actorUrl.toLowerCase()}`);
    if (m.handle) keys.add(`activitypub:${stripAt(m.handle)}`);
    if (ACCT_SHAPE.test(x.sourceUri))
      keys.add(`activitypub:${stripAt(x.sourceUri)}`);
  }
  return [...keys];
}

/** True when the candidate is a bridge mirror (host/handle pattern, or a
 *  NIP-48 proxy tag pointing at a protocol we can key). */
function isMirror(m: ResolverMatch): boolean {
  if (m.proxy && proxyOriginKeys(m.proxy).length > 0) return true;
  const src = asBridgeSource(m);
  return src ? isBridgeMirror(src) : false;
}

/** NIP-48 proxy origin → keys in the shared bridge key-space. Best-effort:
 *  only protocols we can canonically key contribute. */
function proxyOriginKeys(proxy: { origin: string; protocol: string }): string[] {
  const keys: string[] = [];
  const protocol = proxy.protocol.toLowerCase();
  if (protocol === "atproto") {
    const did = extractDid(proxy.origin);
    if (did) keys.push(`atproto:${did}`);
  } else if (protocol === "activitypub") {
    const origin = proxy.origin.trim();
    if (ACCT_SHAPE.test(origin)) keys.push(`ap:${stripAt(origin)}`);
    else if (origin) keys.push(`ap-actor:${origin.toLowerCase()}`);
  }
  return keys;
}

/** The decoded origin key(s) this candidate points at, if it is a mirror. */
function mirrorOriginKeys(m: ResolverMatch): string[] {
  const keys: string[] = [];
  const src = asBridgeSource(m);
  if (src) keys.push(...bridgeIdentityKeys(src));
  if (m.proxy) keys.push(...proxyOriginKeys(m.proxy));
  return keys;
}

/** The native identity key(s) a NON-mirror candidate owns, in the same
 *  key-space mirror decodes land in. */
function collisionNativeKeys(m: ResolverMatch): string[] {
  const src = asBridgeSource(m);
  if (!src || isMirror(m)) return [];
  const keys: string[] = [];
  const native = nativeIdentityKey(src);
  if (native) keys.push(native);
  // AP identities are also addressable by actor URI (NIP-48 proxy origins
  // carry the actor URI, not the acct).
  if (src.protocol === "activitypub" && src.source_uri.includes("://")) {
    keys.push(`ap-actor:${src.source_uri.toLowerCase()}`);
  }
  return keys;
}

/**
 * Branch precision within a tier (§6.2 rule 3) — a stable tie-break putting
 * precise/verified branches first. Provenance is recoverable from shape:
 * within the SPECULATIVE tier each discovery branch produces one shape
 * (catalog→rss_feed, Bluesky→atproto, AP→activitypub, Nostr→nostr_external;
 * platform fuzzy search→native_account). exact/probable matches are local or
 * verified (known-world hits arrive in trgm score order) — uniform precision
 * keeps their order via the stable sort.
 */
function precision(m: ResolverMatch): number {
  if (m.confidence !== "speculative") return 0;
  if (m.type === "native_account") return 0; // local platform search
  if (m.type === "rss_feed") return 1; // catalog nomination
  switch (m.externalSource?.protocol) {
    case "atproto":
      return 2;
    case "activitypub":
      return 3;
    case "nostr_external":
      return 4;
    default:
      return 5; // web-search bridge (§7.2), when it ships
  }
}

/** Context priority (§6.2 rule 2, ADR §V.5.3): invite/dm native-first
 *  (mostly moot — skipExternal already filters, but Phase A can still mix),
 *  subscribe/import external-first (import consumes only external sources —
 *  FOLLOW-GRAPH-IMPORT-ADR §7.4), general neutral. */
function contextPriority(m: ResolverMatch, context: ResolveContext): number {
  if (context === "invite" || context === "dm")
    return m.type === "native_account" ? 0 : 1;
  if (context === "subscribe" || context === "import")
    return m.type === "native_account" ? 1 : 0;
  return 0;
}

/**
 * Merge incoming candidates into the existing set: alias dedupe →
 * bridge-collision drop → §6.2 sort. Pure; keeps object references (the
 * nostr enrichment path mutates a match in place after merging).
 */
export function mergeMatches(
  existing: ResolverMatch[],
  incoming: ResolverMatch[],
  context: ResolveContext,
): ResolverMatch[] {
  // 1. Alias dedupe.
  const out: ResolverMatch[] = [];
  const byAlias = new Map<string, number>();
  for (const m of [...existing, ...incoming]) {
    const aliases = dedupeAliases(m);
    const hit = aliases
      .map((a) => byAlias.get(a))
      .find((i) => i !== undefined);
    if (hit === undefined) {
      const idx = out.length;
      out.push(m);
      for (const a of aliases) byAlias.set(a, idx);
    } else {
      if (CONFIDENCE_RANK[m.confidence] < CONFIDENCE_RANK[out[hit].confidence]) {
        out[hit] = m;
      }
      for (const a of aliases) if (!byAlias.has(a)) byAlias.set(a, hit);
    }
  }

  // 2. Bridge-collision drop (§6.1): mirror loses to its native twin.
  const nativeKeys = new Set<string>();
  for (const m of out) for (const k of collisionNativeKeys(m)) nativeKeys.add(k);
  const survivors = out.filter(
    (m) => !mirrorOriginKeys(m).some((k) => nativeKeys.has(k)),
  );

  // 3. §6.2 ordering. Array.prototype.sort is stable, so equal keys keep
  // insertion order (which is persistence/score order).
  return survivors.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      contextPriority(a, context) - contextPriority(b, context) ||
      precision(a) - precision(b),
  );
}
