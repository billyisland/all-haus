import { safeFetch } from "./http-client.js";
import { authoritativeId, httpOrigin } from "./activitypub-origin.js";
import logger from "./logger.js";

// =============================================================================
// Mastodon client API — the read path that survives AUTHORIZED_FETCH
//
// An instance in secure mode (`AUTHORIZED_FETCH=true`, the default on
// mastodon.social and hachyderm.io since 2026) answers every UNSIGNED
// ActivityPub GET with `401 {"error":"Request not signed"}`. We sign nothing,
// so on those instances the actor document is simply unreadable — which took
// out the resolver (a pasted handle produced no match at all), addSource's
// liveness probe (following any account there answered 422) and the outbox
// poll (which burned the error budget and DEACTIVATED the source at
// `feed_ingest_max_error_count`; 381 rows on dev, every mastodon.social one).
//
// The client API is not in that refusal: `/api/v1/accounts/lookup`,
// `/api/v1/accounts/:id` and `/api/v1/accounts/:id/statuses` are public and
// unsigned on the same instances that 401 the actor. `author-timeline-
// hydration.ts` has read Mastodon this way all along; this module is that
// pattern made the ONE home, because the gateway and feed-ingest both need it
// and two copies of "which endpoint, which fields" would drift in silence.
//
// It is a FALLBACK, not a replacement. ActivityPub is the protocol and the
// outbox is the richer document (a reply carries its parent's URI there, and
// this API gives only a local numeric id — see `parentUriFor`). Callers try AP
// first and come here when `isSignedFetchRefusal` says the instance refused an
// unsigned read. The proper fix is HTTP Signatures with an instance actor,
// which covers non-Mastodon secure-mode servers too; this covers the
// Mastodon-compatible world, which is nearly everything a member will paste.
//
// THE ID-SPACE IS THE SAME ONE. `Status.uri` and `Account.uri` are the
// federated ActivityPub ids — byte-identical to what the outbox path stores —
// so a source that switches between the two readers keeps one
// `source_item_uri` and dedups against itself. Anything that returns the
// human `url` instead would mint a second `post_id` for a status already
// ingested (the ingest invariant's `uri || url` trap, one door along).
// =============================================================================

const JSON_ACCEPT = "application/json";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Did the instance refuse an unsigned ActivityPub read?
 *
 * 401 is Mastodon's `AUTHORIZED_FETCH` answer; 403 is what several other
 * implementations (and some reverse proxies in front of Mastodon) send for the
 * same condition. Both mean "signed fetch required", and both are worth a
 * client-API retry — where a 404/410 is a fact about the ACCOUNT and a 5xx is
 * a fact about the moment, neither of which a second endpoint would change.
 */
export function isSignedFetchRefusal(status: number): boolean {
  return status === 401 || status === 403;
}

// -----------------------------------------------------------------------------
// Addressing an account from an actor URI
//
// `/@name` and `/users/name` are Mastodon's two actor spellings; `/u/`, `/c/`
// and `/m/` are the threadiverse's. `/ap/users/<id>` is Mastodon's newer
// id-addressed actor URI and carries NO username — but the digits in it ARE
// the instance-local account id, which `/api/v1/accounts/:id` takes directly,
// so it resolves without a handle rather than being unaddressable (two such
// rows already sit in `external_sources`, and the old handle-only parser returned
// null for both).
// -----------------------------------------------------------------------------

export type MastodonActorRef =
  | { kind: "acct"; acct: string }
  | { kind: "id"; id: string };

export function mastodonRefFromActorUri(
  actorUri: string,
): MastodonActorRef | null {
  let u: URL;
  try {
    u = new URL(actorUri);
  } catch {
    return null;
  }

  // Id-addressed actor (`/ap/users/116713870499595477`) — check BEFORE the
  // `/users/` shape, which would otherwise swallow it and look the digits up
  // as though they were a username.
  const idMatch = u.pathname.match(/^\/ap\/users\/(\d+)\/?$/);
  if (idMatch) return { kind: "id", id: idMatch[1] };

  const nameMatch =
    u.pathname.match(/^\/@([^/@]+)\/?$/) ??
    u.pathname.match(/^\/users\/([^/]+)\/?$/) ??
    u.pathname.match(/^\/[ucm]\/([^/]+)\/?$/);
  if (!nameMatch) return null;
  return { kind: "acct", acct: `${decodeURIComponent(nameMatch[1])}@${u.hostname}` };
}

/**
 * A Mastodon `acct` is bare for the instance's OWN accounts and `user@host`
 * for everyone else. A byline or a follow-graph entry needs the qualified
 * form, or two people called `alice` on different instances collapse.
 */
export function qualifyAcct(acct: string, host: string): string {
  return acct.includes("@") ? acct : `${acct}@${host}`;
}

// -----------------------------------------------------------------------------
// Account entity
// -----------------------------------------------------------------------------

export interface MastodonAccount {
  id: string;
  /** Instance-local spelling — bare for local accounts. */
  acct: string;
  /** Canonical ActivityPub actor URI, or null if the instance withheld one. */
  uri: string | null;
  /** Human profile page. */
  url: string | null;
  displayName: string | null;
  /** Bio, as HTML — the caller strips or sanitises to its own bar. */
  note: string | null;
  avatar: string | null;
  followingCount: number | null;
  followersCount: number | null;
  statusesCount: number | null;
}

/**
 * `uri` is checked as an https URL because it is stored as a source's
 * identity: an instance that serves a relative or http one must leave the
 * column NULL rather than have a WebFinger fallback (follow-import) or an AP
 * retry (the resolver) skipped on the strength of a value that cannot be one.
 */
export function parseMastodonAccount(raw: unknown): MastodonAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.acct !== "string") return null;

  let uri: string | null = null;
  if (typeof a.uri === "string") {
    try {
      if (new URL(a.uri).protocol === "https:") uri = a.uri;
    } catch {
      // not a URL — leave null; callers have their own fallback
    }
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : null);

  return {
    id: a.id,
    acct: a.acct,
    uri,
    url: str(a.url),
    displayName: str(a.display_name),
    note: str(a.note),
    avatar: str(a.avatar),
    followingCount: num(a.following_count),
    followersCount: num(a.followers_count),
    statusesCount: num(a.statuses_count),
  };
}

/**
 * The identity an account read through the client API may claim: its actor id
 * and that id's host.
 *
 * §2.9 IS NOT RELAXED ON THIS DOOR. The account's `uri` is checked against the
 * actor URI we asked about exactly as the ActivityPub arm checks `actor.id`
 * against `res.url`, so an instance cannot claim through its API an id the
 * front door would have refused. Where the instance serves no `uri`, the one
 * we asked for stands — it is ours, not the document's, so nothing is taken on
 * the instance's word. Null (logged) when the claim fails.
 *
 * One home because the gateway's profile reader and ingest's actor reader both
 * need it, and the check drifting between them would open one door and not the
 * other.
 */
export function mastodonAccountIdentity(
  account: MastodonAccount,
  askedFor: string,
): { id: string; host: string } | null {
  const id = account.uri ? authoritativeId(account.uri, askedFor) : askedFor;
  if (!id) {
    logger.warn(
      { actorUri: askedFor, claimed: account.uri },
      "Mastodon account uri is not authoritative for the host that served it",
    );
    return null;
  }
  try {
    return { id, host: new URL(id).hostname };
  } catch {
    return null;
  }
}

/**
 * The identity a STATUS read through the client API may claim: its federated
 * id and its author's actor id — both on the origin that served it, or
 * nothing (CA-A10, 2026-09-29).
 *
 * §2.9 IS NOT RELAXED ON THIS DOOR EITHER. Five context writers (the
 * gateway's parent, quote and thread-focus fetchers; ingest's parent and
 * quote prefetch) read `/api/v1/statuses/:id` on the host the CHILD's reply
 * or quote uri named and stored `status.uri || status.url` as the dedup key
 * and `status.account.uri ?? url` as the author — on the instance's word. A
 * hostile instance answering with a victim's status id and actor squats the
 * real post's `(protocol, source_item_uri)` (the promotion arm keeps stored
 * content), merges a forged permalink into it, and has the identity trigger
 * overwrite the victim's `external_authors` name and avatar. The client API
 * does not redirect, so the authority is the api origin we asked
 * (`https://<host>`), exactly as `mastodonAccountIdentity`'s `askedFor`.
 *
 * Both ids must pass, and neither falls back: a status with no federated
 * `uri`, or an account with no actor `uri`, is refused rather than keyed on a
 * web url the instance could equally have chosen. Null is LOGGED.
 */
export function mastodonStatusIdentity(
  status: { uri?: unknown; url?: unknown; account?: { uri?: unknown; url?: unknown } | null },
  apiOrigin: string,
): { uri: string; authorUri: string } | null {
  const uri = authoritativeId(status.uri, apiOrigin);
  const authorUri = authoritativeId(status.account?.uri, apiOrigin);
  if (!uri || !authorUri) {
    logger.warn(
      {
        apiOrigin,
        claimedUri: status.uri ?? null,
        claimedAuthor: status.account?.uri ?? null,
      },
      "Mastodon status identity is not authoritative for the host that served it — skipped",
    );
    return null;
  }
  return { uri, authorUri };
}

// -----------------------------------------------------------------------------
// The raw read — every public Mastodon client-API GET goes through here
//
// Two layers, and the split is the contract. The `read*` functions below
// return the WIRE answer — `ok`, the HTTP status, the parsed JSON body — and
// THROW on a transport fault, exactly as `safeFetch` does; they decide which
// endpoint, which query and which headers, and nothing else. What a caller
// does with a 429 against a 404 (a hydrator throws the first so its guard
// clears and settles on the second) and which fields it reads off the body
// (engagement counts, a link card, the account's `uri`) stay the caller's.
// The typed `fetch*` functions further down are built on them, never throw,
// and answer null on any failure.
//
// `ok` is false for a body that is not JSON, with the status left as served.
// `link` is the raw `Link` header, for the one pager that walks it.
//
// Not here, on purpose: AUTHENTICATED writes on a member's own instance
// (`feed-ingest/src/adapters/activitypub-outbound.ts`, `linked-accounts.ts`'s
// app registration) — they are the member's session, not a public read.
// -----------------------------------------------------------------------------

export interface MastodonRead {
  ok: boolean;
  status: number;
  body: unknown;
  link: string | null;
}

export interface MastodonReadOpts {
  accessToken?: string;
  timeout?: number;
}

export async function readMastodonJson(
  url: string,
  opts: MastodonReadOpts = {},
): Promise<MastodonRead> {
  const headers: Record<string, string> = { Accept: JSON_ACCEPT };
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
  const res = await safeFetch(url, {
    headers,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
  });
  const link = res.headers?.get?.("link") ?? null;
  if (!res.ok) return { ok: false, status: res.status, body: null, link };
  try {
    return { ok: true, status: res.status, body: JSON.parse(res.text), link };
  } catch {
    return { ok: false, status: res.status, body: null, link };
  }
}

/**
 * The instance-local status id at the end of a status URI —
 * `/users/alice/statuses/123` or `/@alice/123` — which is what
 * `/api/v1/statuses/:id` takes. Null for anything that does not end in one.
 */
export function extractMastodonStatusId(uri: string): string | null {
  try {
    const parts = new URL(uri).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /^\d+$/.test(last)) return last;
    return null;
  } catch {
    return null;
  }
}

export function readMastodonStatus(
  apiOrigin: string,
  statusId: string,
  opts: MastodonReadOpts = {},
): Promise<MastodonRead> {
  return readMastodonJson(
    `${apiOrigin}/api/v1/statuses/${encodeURIComponent(statusId)}`,
    opts,
  );
}

/** `{ ancestors, descendants }` around one status. */
export function readMastodonStatusContext(
  apiOrigin: string,
  statusId: string,
  opts: MastodonReadOpts = {},
): Promise<MastodonRead> {
  return readMastodonJson(
    `${apiOrigin}/api/v1/statuses/${encodeURIComponent(statusId)}/context`,
    opts,
  );
}

/** One account, by whichever handle the actor URI gave us (`mastodonRefFromActorUri`). */
export function readMastodonAccount(
  apiOrigin: string,
  ref: MastodonActorRef,
  opts: MastodonReadOpts = {},
): Promise<MastodonRead> {
  return readMastodonJson(
    ref.kind === "id"
      ? `${apiOrigin}/api/v1/accounts/${encodeURIComponent(ref.id)}`
      : `${apiOrigin}/api/v1/accounts/lookup?acct=${encodeURIComponent(ref.acct)}`,
    opts,
  );
}

export interface MastodonStatusesQuery {
  limit: number;
  /** Exclusive; pages strictly backwards in time. */
  maxId?: string;
  excludeReplies?: boolean;
  excludeReblogs?: boolean;
}

export function readMastodonAccountStatuses(
  apiOrigin: string,
  accountId: string,
  query: MastodonStatusesQuery,
  opts: MastodonReadOpts = {},
): Promise<MastodonRead> {
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(40, query.limit))),
  });
  if (query.maxId) params.set("max_id", query.maxId);
  if (query.excludeReplies) params.set("exclude_replies", "true");
  if (query.excludeReblogs) params.set("exclude_reblogs", "true");
  return readMastodonJson(
    `${apiOrigin}/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?${params}`,
    opts,
  );
}

/** First page of who an account follows; later pages come from `link`. */
export function readMastodonFollowing(
  apiOrigin: string,
  accountId: string,
  opts: MastodonReadOpts = {},
): Promise<MastodonRead> {
  return readMastodonJson(
    `${apiOrigin}/api/v1/accounts/${encodeURIComponent(accountId)}/following?limit=80`,
    opts,
  );
}

/** `/api/v2/search` for accounts, without `resolve` (so no federation fetch). */
export function readMastodonAccountSearch(
  apiOrigin: string,
  query: string,
  limit: number,
  opts: MastodonReadOpts = {},
): Promise<MastodonRead> {
  return readMastodonJson(
    `${apiOrigin}/api/v2/search?q=${encodeURIComponent(query)}&type=accounts&limit=${limit}`,
    opts,
  );
}

export async function lookupMastodonAccountByAcct(
  apiOrigin: string,
  acct: string,
  opts: { accessToken?: string; timeout?: number } = {},
): Promise<MastodonAccount | null> {
  try {
    const { ok, body } = await readMastodonAccount(
      apiOrigin,
      { kind: "acct", acct },
      opts,
    );
    return ok ? parseMastodonAccount(body) : null;
  } catch (err) {
    logger.warn({ apiOrigin, acct, err }, "Mastodon account lookup failed");
    return null;
  }
}

export async function fetchMastodonAccountById(
  apiOrigin: string,
  id: string,
  opts: { accessToken?: string; timeout?: number } = {},
): Promise<MastodonAccount | null> {
  try {
    const { ok, body } = await readMastodonAccount(
      apiOrigin,
      { kind: "id", id },
      opts,
    );
    return ok ? parseMastodonAccount(body) : null;
  } catch (err) {
    logger.warn({ apiOrigin, id, err }, "Mastodon account fetch failed");
    return null;
  }
}

/**
 * Resolve whatever an actor URI addresses, on that URI's own host.
 *
 * The origin comes from the actor URI rather than from WebFinger because this
 * is the fallback for a document we already tried to fetch THERE — the host
 * that refused the unsigned read is the host whose API answers for it.
 */
export async function fetchMastodonAccountByActorUri(
  actorUri: string,
  opts: { accessToken?: string; timeout?: number } = {},
): Promise<MastodonAccount | null> {
  const origin = httpOrigin(actorUri);
  const ref = mastodonRefFromActorUri(actorUri);
  if (!origin || !ref) return null;
  return ref.kind === "id"
    ? fetchMastodonAccountById(origin, ref.id, opts)
    : lookupMastodonAccountByAcct(origin, ref.acct, opts);
}

// -----------------------------------------------------------------------------
// Status entity
// -----------------------------------------------------------------------------

export interface MastodonMediaAttachment {
  type: string;
  url: string;
  preview_url?: string | null;
  description?: string | null;
  meta?: { original?: { width?: number; height?: number } } | null;
}

export interface MastodonStatus {
  id: string;
  /** Federated ActivityPub id — the SAME id-space the outbox path stores. */
  uri: string;
  url: string | null;
  createdAt: Date;
  /** Instance-local id of the parent, when this is a reply. Not a URI. */
  inReplyToId: string | null;
  visibility: string | null;
  language: string | null;
  contentHtml: string;
  spoilerText: string | null;
  sensitive: boolean;
  account: MastodonAccount | null;
  media: MastodonMediaAttachment[];
  poll: {
    options: Array<{ title: string; votesCount: number }>;
    multiple: boolean;
    expiresAt: string | null;
    closed: boolean;
  } | null;
  /** Quote-post target's federated uri (Mastodon 4.4+ `quote`), when present. */
  quoteUri: string | null;
  /** Set when this status is a boost of another — the boosted status. */
  reblog: MastodonStatus | null;
}

function parsePoll(raw: unknown): MastodonStatus["poll"] {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.options)) return null;
  return {
    options: p.options.map((o) => {
      const opt = (o ?? {}) as Record<string, unknown>;
      return {
        title: typeof opt.title === "string" ? opt.title : "",
        votesCount: typeof opt.votes_count === "number" ? opt.votes_count : 0,
      };
    }),
    multiple: p.multiple === true,
    expiresAt: typeof p.expires_at === "string" ? p.expires_at : null,
    closed: p.expired === true,
  };
}

// Mastodon 4.4 serialises a quote as `{ state, quoted_status }`; earlier
// Fedibird/Misskey bridges put the target's url on `quote` directly. Only an
// ACCEPTED quote carries a status, and only its `uri` is in our id-space.
function parseQuoteUri(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const q = raw as Record<string, unknown>;
  const quoted = q.quoted_status;
  if (typeof quoted === "object" && quoted !== null) {
    const qs = quoted as Record<string, unknown>;
    if (typeof qs.uri === "string") return qs.uri;
    if (typeof qs.url === "string") return qs.url;
  }
  return null;
}

export function parseMastodonStatus(raw: unknown): MastodonStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string") return null;
  // `uri` is the identity. A status without one cannot be stored without
  // inventing an id-space, so it is skipped rather than filed under its `url`.
  if (typeof s.uri !== "string") return null;
  const createdAt = new Date(
    typeof s.created_at === "string" ? s.created_at : "",
  );
  if (Number.isNaN(createdAt.getTime())) return null;

  const media = Array.isArray(s.media_attachments)
    ? (s.media_attachments as unknown[]).flatMap((m) => {
        if (typeof m !== "object" || m === null) return [];
        const a = m as Record<string, unknown>;
        if (typeof a.url !== "string" || typeof a.type !== "string") return [];
        return [a as unknown as MastodonMediaAttachment];
      })
    : [];

  return {
    id: s.id,
    uri: s.uri,
    url: typeof s.url === "string" ? s.url : null,
    createdAt,
    inReplyToId: typeof s.in_reply_to_id === "string" ? s.in_reply_to_id : null,
    visibility: typeof s.visibility === "string" ? s.visibility : null,
    language: typeof s.language === "string" ? s.language : null,
    contentHtml: typeof s.content === "string" ? s.content : "",
    spoilerText: typeof s.spoiler_text === "string" ? s.spoiler_text : null,
    sensitive: s.sensitive === true,
    account: parseMastodonAccount(s.account),
    media,
    poll: parsePoll(s.poll),
    quoteUri: parseQuoteUri(s.quote),
    reblog: s.reblog ? parseMastodonStatus(s.reblog) : null,
  };
}

/**
 * One page of an account's statuses, newest first.
 *
 * Returns null when the page could not be read at all — the caller's
 * distinction between "no posts" and "no answer", which decides whether a
 * source's error budget is spent. Boosts and replies are REQUESTED (the outbox
 * carries both and this reader must not quietly deliver a narrower feed); what
 * to do with them is the mapper's call.
 */
export async function fetchMastodonStatuses(
  apiOrigin: string,
  accountId: string,
  limit: number,
  opts: { accessToken?: string; timeout?: number; maxId?: string } = {},
): Promise<MastodonStatus[] | null> {
  try {
    // `max_id` is exclusive and pages strictly backwards in time, which is
    // what lets the caller walk pages the same way the outbox reader does
    // rather than taking one page and calling the rest of the window read.
    const { ok, body } = await readMastodonAccountStatuses(
      apiOrigin,
      accountId,
      { limit, maxId: opts.maxId },
      opts,
    );
    if (!ok || !Array.isArray(body)) return null;
    return body.flatMap((s) => {
      const parsed = parseMastodonStatus(s);
      return parsed ? [parsed] : [];
    });
  } catch (err) {
    logger.warn(
      { apiOrigin, accountId, err },
      "Mastodon statuses fetch failed",
    );
    return null;
  }
}

/**
 * One status by its instance-local id — the only way to turn a reply's
 * `in_reply_to_id` into the parent's federated `uri`, which the outbox gives
 * for free as `inReplyTo`.
 */
export async function fetchMastodonStatusById(
  apiOrigin: string,
  statusId: string,
  opts: { accessToken?: string; timeout?: number } = {},
): Promise<MastodonStatus | null> {
  try {
    const { ok, body } = await readMastodonStatus(apiOrigin, statusId, opts);
    return ok ? parseMastodonStatus(body) : null;
  } catch (err) {
    logger.warn({ apiOrigin, statusId, err }, "Mastodon status fetch failed");
    return null;
  }
}
