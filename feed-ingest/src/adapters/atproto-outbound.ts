import { getAtprotoClient } from "@platform-pub/shared/lib/atproto-oauth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { truncateWithLink } from "../lib/text.js";
import {
  TerminalDeliveryError,
  isTerminalHttpStatus,
} from "../lib/outbound-errors.js";

// =============================================================================
// AT Protocol outbound — writes a record into the linked user's PDS.
//
// We go through NodeOAuthClient.restore(did) which returns an OAuthSession
// with a fetchHandler() that signs XRPC requests with a DPoP proof bound to
// the session's stored key. The session store auto-refreshes tokens if the
// access token is close to expiry.
//
// Post shape (Bluesky app.bsky.feed.post):
//   { $type: 'app.bsky.feed.post', text, createdAt,
//     reply?: { root: StrongRef, parent: StrongRef },
//     embed?: { $type: 'app.bsky.embed.record', record: StrongRef } }  // quote
//
// The 300 limit is *graphemes*, not bytes — we truncate cautiously with
// Intl.Segmenter so CJK / emoji / combining marks all count as one.
//
// EXACTLY ONCE, NOT AT LEAST ONCE (audit §2.16). Every write here is addressed
// to a caller-chosen `rkey` and sent with `com.atproto.repo.putRecord`, not
// `createRecord`:
//
//   • the rkey is derived from the outbound_posts row (lib/atproto-tid.ts), so
//     a retry addresses the same record rather than creating a second one;
//   • `createdAt` comes from the row too, so a retry is byte-identical and
//     putRecord's replace is a no-op on the content;
//   • putRecord is the idempotent-upsert form — createRecord with an occupied
//     rkey would answer 4xx, which the classifier below would read as a
//     refusal and mark the row failed for a post that had actually gone out.
//
// Failures are classified terminal vs ambiguous (lib/outbound-errors.ts). Only
// the ambiguous branch may be retried, and it is safe to retry precisely
// because the rkey is stable.
// =============================================================================

interface AtprotoReplyRef {
  uri: string;
  cid: string;
}

interface AtprotoPostInput {
  did: string;
  text: string;
  maxGraphemes: number;
  /** Record key + timestamp, both derived from the outbound_posts row. */
  rkey: string;
  createdAt: string;
  /** all.haus canonical link appended when the body has to be truncated. */
  allHausUrl?: string;
  reply?: {
    root: AtprotoReplyRef;
    parent: AtprotoReplyRef;
  };
  quote?: AtprotoReplyRef;
}

interface AtprotoPostResult {
  externalPostUri: string;
  cid: string;
}

interface AtprotoLikeResult {
  externalPostUri: string;
}

/** Row-derived identity for a like/repost write. */
export interface AtprotoWriteIdentity {
  rkey: string;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// putRecord — the one path from a record to the member's PDS. Every caller
// below supplies a row-derived rkey, so this function never mints identity.
// -----------------------------------------------------------------------------
async function putRecord(
  did: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
  what: string,
): Promise<{ uri: string; cid: string }> {
  const client = await getAtprotoClient();
  const session = await client.restore(did);

  const res = await session.fetchHandler("/xrpc/com.atproto.repo.putRecord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: did, collection, rkey, record }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const msg = `Bluesky ${what} HTTP ${res.status}: ${errText.slice(0, 200)}`;
    const terminal = isTerminalHttpStatus(res.status);
    logger.warn(
      { status: res.status, errText, did, rkey, terminal },
      `Bluesky ${what} putRecord failed`,
    );
    // A 4xx refused the write and created nothing, so retrying it 3× only
    // delays the member being told. Anything else may already have landed.
    throw terminal ? new TerminalDeliveryError(msg) : new Error(msg);
  }

  const json = (await res.json()) as { uri?: string; cid?: string };
  if (!json.uri || !json.cid)
    throw new Error(`Bluesky ${what} response missing uri/cid`);
  return { uri: json.uri, cid: json.cid };
}

export async function likeBlueskyRecord(
  did: string,
  subject: { uri: string; cid: string },
  identity: AtprotoWriteIdentity,
): Promise<AtprotoLikeResult> {
  const { uri } = await putRecord(
    did,
    "app.bsky.feed.like",
    identity.rkey,
    {
      $type: "app.bsky.feed.like",
      subject: { uri: subject.uri, cid: subject.cid },
      createdAt: identity.createdAt,
    },
    "like",
  );
  return { externalPostUri: uri };
}

export async function repostBlueskyRecord(
  did: string,
  subject: { uri: string; cid: string },
  identity: AtprotoWriteIdentity,
): Promise<AtprotoLikeResult> {
  const { uri } = await putRecord(
    did,
    "app.bsky.feed.repost",
    identity.rkey,
    {
      $type: "app.bsky.feed.repost",
      subject: { uri: subject.uri, cid: subject.cid },
      createdAt: identity.createdAt,
    },
    "repost",
  );
  return { externalPostUri: uri };
}

export async function postBlueskyRecord(
  input: AtprotoPostInput,
): Promise<AtprotoPostResult> {
  const text = truncateWithLink(input.text, {
    max: input.maxGraphemes,
    linkSuffix: input.allHausUrl,
  });
  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: input.createdAt,
    langs: ["en"],
  };
  if (input.reply) {
    record.reply = {
      root: { uri: input.reply.root.uri, cid: input.reply.root.cid },
      parent: { uri: input.reply.parent.uri, cid: input.reply.parent.cid },
    };
  }
  if (input.quote) {
    record.embed = {
      $type: "app.bsky.embed.record",
      record: { uri: input.quote.uri, cid: input.quote.cid },
    };
  }

  const { uri, cid } = await putRecord(
    input.did,
    "app.bsky.feed.post",
    input.rkey,
    record,
    "post",
  );
  return { externalPostUri: uri, cid };
}
