import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import {
  parseMastodonStatus,
  type MastodonStatus,
} from "@platform-pub/shared/lib/mastodon-api.js";
import {
  hasMastodonScope,
  type MastodonScope,
} from "@platform-pub/shared/lib/mastodon-scopes.js";
import { truncateWithLink } from "../lib/text.js";
import {
  CredentialRefusedError,
  TerminalDeliveryError,
  isTerminalHttpStatus,
} from "../lib/outbound-errors.js";

// =============================================================================
// ActivityPub (Mastodon) outbound adapter
//
// Posts a status via POST /api/v1/statuses on the user's home instance. For
// replies, we need in_reply_to_id — a local status identifier on the user's
// instance. When the source item lives on a different instance, we first call
// /api/v2/search to have the user's instance federate it, then reply to the
// resulting local status id. Mastodon instances return a `statuses[0].id`
// from the search result.
//
// Posts longer than the instance's status limit are truncated with a trailing
// link back to all.haus (the canonical, full-length version).
//
// A REPLY IS NEVER POSTED WITHOUT ITS PARENT (CROSS-NETWORK-ROUNDTRIP-ADR F5/A4).
// `resolveRemoteStatus` used to answer `undefined` for a refused or empty
// search, and the status then went out with no `in_reply_to_id` — a public,
// context-free top-level post to the member's followers. It now throws on every
// failure, split like every other outbound write: a 4xx (bar 429) or an empty
// result is terminal, anything else is ambiguous and retried.
//
// Every call first asks the token's GRANTED scope (`requireScope`), because a
// token minted before a scope was added keeps its narrow grant until the member
// reconnects; the endpoint→scope pairing is pinned against this file by
// `activitypub-outbound.scopes.test.ts`.
// =============================================================================

export interface MastodonCredentials {
  accessToken: string;
  tokenType?: string;
  scope?: string;
}

interface MastodonOutboundInput {
  instanceUrl: string;
  text: string;
  maxChars: number;
  sourceHomeUrl?: string; // canonical all.haus URL for truncation fallback
  replyToStatusUri?: string; // external_items.source_item_uri when action=reply
  // The member on their own instance — network_presences.external_id (the
  // account id the search answers in) and .handle (`user@host`). A reply to
  // their own status is not prefixed with a mention of themselves.
  self?: MastodonSelf;
  idempotencyKey: string; // stable across retries — typically outbound_posts.id
}

interface MastodonOutboundResult {
  externalPostUri: string;
}

export async function postMastodonStatus(
  input: MastodonOutboundInput,
  credentials: MastodonCredentials,
): Promise<MastodonOutboundResult> {
  requireScope(credentials, "write:statuses");
  let inReplyToId: string | undefined;
  let text = input.text;
  if (input.replyToStatusUri) {
    const parent = await resolveRemoteStatus(
      input.instanceUrl,
      input.replyToStatusUri,
      credentials,
    );
    inReplyToId = parent.id;
    text = withReplyMention(
      text,
      parent.account,
      input.self,
      new URL(input.instanceUrl).hostname,
    );
  }

  const status = truncateWithLink(text, {
    max: input.maxChars,
    linkSuffix: input.sourceHomeUrl,
    separator: " ",
  });
  const body: Record<string, unknown> = {
    status,
    visibility: "public",
  };
  if (inReplyToId) body.in_reply_to_id = inReplyToId;

  const res = await safeFetch(`${input.instanceUrl}/api/v1/statuses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throwHttp("statuses", res);

  const parsed = JSON.parse(res.text) as {
    id: string;
    uri: string;
    url?: string;
  };
  return {
    externalPostUri:
      parsed.uri ?? parsed.url ?? `${input.instanceUrl}/statuses/${parsed.id}`,
  };
}

// -----------------------------------------------------------------------------
// Favourite a status on the user's home instance.
// Resolves the remote status first (triggers federation if needed), then hits
// POST /api/v1/statuses/:id/favourite.
// -----------------------------------------------------------------------------

export async function favouriteMastodonStatus(
  instanceUrl: string,
  statusUri: string,
  credentials: MastodonCredentials,
): Promise<{ externalPostUri: string }> {
  requireScope(credentials, "write:favourites");
  const { id: localId } = await resolveRemoteStatus(
    instanceUrl,
    statusUri,
    credentials,
  );

  const res = await safeFetch(
    `${instanceUrl}/api/v1/statuses/${localId}/favourite`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!res.ok) throwHttp("favourite", res);

  const parsed = JSON.parse(res.text) as {
    id: string;
    uri: string;
    url?: string;
  };
  return {
    externalPostUri:
      parsed.uri ?? parsed.url ?? `${instanceUrl}/statuses/${parsed.id}`,
  };
}

// -----------------------------------------------------------------------------
// Reblog/boost a status on the user's home instance.
// Resolves the remote status first (triggers federation if needed), then hits
// POST /api/v1/statuses/:id/reblog.
// -----------------------------------------------------------------------------

export async function reblogMastodonStatus(
  instanceUrl: string,
  statusUri: string,
  credentials: MastodonCredentials,
): Promise<{ externalPostUri: string }> {
  requireScope(credentials, "write:statuses");
  const { id: localId } = await resolveRemoteStatus(
    instanceUrl,
    statusUri,
    credentials,
  );

  const res = await safeFetch(
    `${instanceUrl}/api/v1/statuses/${localId}/reblog`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!res.ok) throwHttp("reblog", res);

  const parsed = JSON.parse(res.text) as {
    id: string;
    uri: string;
    url?: string;
  };
  return {
    externalPostUri:
      parsed.uri ?? parsed.url ?? `${instanceUrl}/statuses/${parsed.id}`,
  };
}

// -----------------------------------------------------------------------------
// Vote on a Mastodon poll.
// Resolves the remote status to get the local poll ID, then POSTs the vote.
// -----------------------------------------------------------------------------

export async function voteMastodonPoll(
  instanceUrl: string,
  statusUri: string,
  choices: number[],
  credentials: MastodonCredentials,
): Promise<{ externalPostUri: string }> {
  requireScope(credentials, "read:statuses");
  requireScope(credentials, "write:statuses");
  const { id: localId } = await resolveRemoteStatus(
    instanceUrl,
    statusUri,
    credentials,
  );

  const statusRes = await safeFetch(
    `${instanceUrl}/api/v1/statuses/${localId}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!statusRes.ok) throwHttp("status fetch", statusRes);

  const status = JSON.parse(statusRes.text) as { poll?: { id: string } };
  if (!status.poll?.id)
    throw new TerminalDeliveryError(
      `Status ${localId} has no poll on ${instanceUrl}`,
    );

  const res = await safeFetch(
    `${instanceUrl}/api/v1/polls/${status.poll.id}/votes`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ choices }),
    },
  );

  if (!res.ok) throwHttp("poll vote", res);

  return { externalPostUri: `${instanceUrl}/statuses/${localId}` };
}

// -----------------------------------------------------------------------------
// Resolve an external status URI to a status id local to the user's instance.
// Mastodon's /api/v2/search with `resolve=true` triggers federation-fetch.
//
// Answers an id or THROWS — there is no "not found" return, because the one
// caller that could proceed without an id (a reply) must not.
// -----------------------------------------------------------------------------

interface ResolvedStatus {
  id: string;
  // The status's author as the member's instance names them — `acct` is bare
  // for a local account and `user@host` for a remote one, which is exactly the
  // form a mention typed on that instance takes. Null where the shortcut below
  // could not read a name out of the URI.
  account: { id: string | null; acct: string } | null;
}

async function resolveRemoteStatus(
  instance: string,
  uri: string,
  credentials: MastodonCredentials,
): Promise<ResolvedStatus> {
  // If the URI is already on the same instance, extract the trailing id — and,
  // from Mastodon's `/users/<name>/statuses/<id>` shape, the local author.
  try {
    const u = new URL(uri);
    const home = new URL(instance);
    if (u.hostname === home.hostname) {
      const m = u.pathname.match(/(?:statuses|notes)\/([a-zA-Z0-9]+)\/?$/);
      if (m) {
        const name = u.pathname.match(/^\/users\/([^/]+)\/statuses\//)?.[1];
        return {
          id: m[1],
          account: name ? { id: null, acct: decodeURIComponent(name) } : null,
        };
      }
    }
  } catch {
    /* fall through */
  }

  requireScope(credentials, "read:search");

  const search = new URL(`${instance}/api/v2/search`);
  search.searchParams.set("q", uri);
  search.searchParams.set("resolve", "true");
  search.searchParams.set("limit", "1");
  search.searchParams.set("type", "statuses");

  const res = await safeFetch(search.toString(), {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throwHttp("search", res);

  const parsed = JSON.parse(res.text) as {
    statuses?: { id: string; account?: { id?: string; acct?: string } }[];
  };
  const hit = parsed.statuses?.[0];
  const id = hit?.id;
  if (!id) {
    // The member's instance answered and found nothing: the post is gone, or
    // their instance cannot see it. Retrying under the same question gets the
    // same answer.
    throw new TerminalDeliveryError(
      `The post couldn't be found from your instance (${new URL(instance).hostname})`,
    );
  }
  const acct = hit.account?.acct;
  return {
    id,
    account: acct ? { id: hit.account?.id ?? null, acct } : null,
  };
}

// A5: a reply names the author it answers, the way every Mastodon client
// writes one. Mastodon notifies on MENTION, and a Create activity addressed to
// nobody on the parent's instance may never be delivered there — so without
// the prefix the author is not told, and may not even see the reply under
// their own post. Prepended, never appended: truncation clips the TAIL, so the
// mention survives any length. Skipped where the body already names them
// (case-insensitive, whole handle only) and where the parent is the member's
// own status.
export interface MastodonSelf {
  accountId: string | null;
  handle: string | null;
}

export function withReplyMention(
  text: string,
  author: { id: string | null; acct: string } | null,
  self: MastodonSelf | undefined,
  homeHost: string,
): string {
  if (!author) return text;
  if (self?.accountId && author.id && author.id === self.accountId) return text;
  const full = author.acct.includes("@") ? author.acct : `${author.acct}@${homeHost}`;
  if (self?.handle && full.toLowerCase() === self.handle.toLowerCase())
    return text;
  const handle = `@${author.acct}`;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^\\w@])${escaped}(?![\\w@.-]*[\\w])`, "i").test(text))
    return text;
  return `${handle} ${text}`;
}

// A token that lacks a scope is refused BEFORE the call, with the member's
// remedy as the message — the far end's 403 would say the same thing less
// usefully, and for the search it would say it only after we had asked.
export function requireScope(
  credentials: MastodonCredentials,
  scope: MastodonScope,
): void {
  if (!hasMastodonScope(credentials.scope, scope)) {
    throw new TerminalDeliveryError(
      `Reconnect your Mastodon account in Settings to do this from all.haus (missing ${scope})`,
    );
  }
}

// A 4xx other than 429 refused the request and created nothing (terminal); a
// 401/403 is the token, so the message names the remedy. Anything else — a
// 429, a 5xx — may have landed, and is retried.
export function throwHttp(
  what: string,
  res: { status: number; text: string },
): never {
  const detail = `Mastodon ${what} HTTP ${res.status}: ${res.text.slice(0, 200)}`;
  if (!isTerminalHttpStatus(res.status)) throw new Error(detail);
  // 401 is the TOKEN refused (revoked, expired, unknown) — the presence is
  // invalidated by whoever catches it. 403 is a token that is fine and may not
  // do this, which reconnecting may or may not fix, so it invalidates nothing.
  if (res.status === 401) {
    throw new CredentialRefusedError(
      `Reconnect your Mastodon account in Settings — ${detail}`,
    );
  }
  if (res.status === 403) {
    throw new TerminalDeliveryError(
      `Reconnect your Mastodon account in Settings — ${detail}`,
    );
  }
  throw new TerminalDeliveryError(detail);
}

// -----------------------------------------------------------------------------
// AUTHENTICATED READS for the linked-notification poller
// (CROSS-NETWORK-ROUNDTRIP-ADR C1). Here rather than beside the Bluesky reader
// because this is the file where a call on a member's own instance, with their
// token, is spelled — `requireScope` and `throwHttp` are its, and the
// endpoint→scope pin reads it. A 401 throws CredentialRefusedError, which the
// poller turns into an invalidated presence.
// -----------------------------------------------------------------------------

/** A reply arrives as a `mention`; `quote` is Mastodon 4.5's own type, and an
 *  instance that predates it ignores the unknown filter. */
export const MASTODON_NOTIFICATION_TYPES = ["mention", "quote"] as const;

export interface MastodonNotification {
  /** Instance-local, and ORDERED: a later notification has a larger id. */
  id: string;
  type: string;
  status: MastodonStatus;
  /** The instance-local account id the status replies to, if a reply. */
  inReplyToAccountId: string | null;
}

export const MASTODON_PAGE_LIMIT = 40;

/**
 * One page of the member's mentions and quotes. With `minId` it is the page
 * immediately AFTER that id — the forward walk that lets a cap keep the OLDEST
 * unseen items and resume from them (the ingest cap rule); without it, the
 * newest page. Either way the items are returned OLDEST first.
 */
export async function listMastodonNotifications(
  instanceUrl: string,
  credentials: MastodonCredentials,
  minId: string | null,
): Promise<MastodonNotification[]> {
  requireScope(credentials, "read:notifications");
  const url = new URL(`${instanceUrl}/api/v1/notifications`);
  for (const t of MASTODON_NOTIFICATION_TYPES) url.searchParams.append("types[]", t);
  url.searchParams.set("limit", String(MASTODON_PAGE_LIMIT));
  if (minId) url.searchParams.set("min_id", minId);
  const res = await safeFetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throwHttp("notifications", res);
  const raw = JSON.parse(res.text) as unknown;
  const out: MastodonNotification[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== "object" || item === null) continue;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== "string" || typeof n.type !== "string") continue;
    const status = parseMastodonStatus(n.status);
    if (!status) continue;
    const s = n.status as Record<string, unknown>;
    out.push({
      id: n.id,
      type: n.type,
      status,
      inReplyToAccountId:
        typeof s.in_reply_to_account_id === "string"
          ? s.in_reply_to_account_id
          : null,
    });
  }
  return out.sort((a, b) => compareMastodonIds(a.id, b.id));
}

/**
 * Read a status on the member's OWN instance by its local id — how a reply's
 * parent is named in the client API (`in_reply_to_id`), in nobody else's
 * id-space. Authenticated, so a parent that is followers-only (the member's
 * own, usually) still resolves. Answers null for a 404: the parent is gone.
 */
export async function readHomeInstanceStatus(
  instanceUrl: string,
  credentials: MastodonCredentials,
  localId: string,
): Promise<MastodonStatus | null> {
  requireScope(credentials, "read:statuses");
  const id = encodeURIComponent(localId);
  const res = await safeFetch(
    `${instanceUrl}/api/v1/statuses/${id}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throwHttp("status fetch", res);
  return parseMastodonStatus(JSON.parse(res.text));
}

/** Mastodon ids are decimal snowflakes, longer than a double holds exactly. */
export function compareMastodonIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
