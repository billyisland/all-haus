import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { truncateWithLink } from "../lib/text.js";

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
  idempotencyKey: string; // stable across retries — typically outbound_posts.id
}

interface MastodonOutboundResult {
  externalPostUri: string;
}

export async function postMastodonStatus(
  input: MastodonOutboundInput,
  credentials: MastodonCredentials,
): Promise<MastodonOutboundResult> {
  let inReplyToId: string | undefined;
  if (input.replyToStatusUri) {
    inReplyToId = await resolveRemoteStatus(
      input.instanceUrl,
      input.replyToStatusUri,
      credentials,
    );
  }

  const status = truncateWithLink(input.text, {
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
  if (!res.ok)
    throw new Error(
      `Mastodon statuses HTTP ${res.status}: ${res.text.slice(0, 200)}`,
    );

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
  const localId = await resolveRemoteStatus(
    instanceUrl,
    statusUri,
    credentials,
  );
  if (!localId)
    throw new Error(`Could not resolve status ${statusUri} on ${instanceUrl}`);

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

  if (!res.ok)
    throw new Error(
      `Mastodon favourite HTTP ${res.status}: ${res.text.slice(0, 200)}`,
    );

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
  const localId = await resolveRemoteStatus(
    instanceUrl,
    statusUri,
    credentials,
  );
  if (!localId)
    throw new Error(`Could not resolve status ${statusUri} on ${instanceUrl}`);

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

  if (!res.ok)
    throw new Error(
      `Mastodon reblog HTTP ${res.status}: ${res.text.slice(0, 200)}`,
    );

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
  const localId = await resolveRemoteStatus(
    instanceUrl,
    statusUri,
    credentials,
  );
  if (!localId)
    throw new Error(`Could not resolve status ${statusUri} on ${instanceUrl}`);

  const statusRes = await safeFetch(
    `${instanceUrl}/api/v1/statuses/${localId}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!statusRes.ok)
    throw new Error(
      `Mastodon status fetch HTTP ${statusRes.status}: ${statusRes.text.slice(0, 200)}`,
    );

  const status = JSON.parse(statusRes.text) as { poll?: { id: string } };
  if (!status.poll?.id)
    throw new Error(`Status ${localId} has no poll on ${instanceUrl}`);

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

  if (!res.ok)
    throw new Error(
      `Mastodon poll vote HTTP ${res.status}: ${res.text.slice(0, 200)}`,
    );

  return { externalPostUri: `${instanceUrl}/statuses/${localId}` };
}

// -----------------------------------------------------------------------------
// Resolve an external status URI to a status id local to the user's instance.
// Mastodon's /api/v2/search with `resolve=true` triggers federation-fetch.
// -----------------------------------------------------------------------------

async function resolveRemoteStatus(
  instance: string,
  uri: string,
  credentials: MastodonCredentials,
): Promise<string | undefined> {
  // If the URI is already on the same instance, extract the trailing id.
  try {
    const u = new URL(uri);
    const home = new URL(instance);
    if (u.hostname === home.hostname) {
      const m = u.pathname.match(/(?:statuses|notes)\/([a-zA-Z0-9]+)\/?$/);
      if (m) return m[1];
    }
  } catch {
    /* fall through */
  }

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
  if (!res.ok) return undefined;

  const parsed = JSON.parse(res.text) as { statuses?: { id: string }[] };
  return parsed.statuses?.[0]?.id;
}
