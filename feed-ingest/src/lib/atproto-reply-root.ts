import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import {
  TerminalDeliveryError,
  isTerminalHttpStatus,
} from "./outbound-errors.js";

// =============================================================================
// The ROOT a Bluesky reply names (CROSS-NETWORK-ROUNDTRIP-ADR F6 / A8).
//
// A reply record carries two strong refs, `parent` and `root`. The parent is
// the row the member pressed Reply on; the root is the top of that row's
// thread, and it is ONLY known if the row's interaction_data recorded it.
// Real ingest always did. Context rows written before A8 did not — and for them
// the worker used to fall back to `root = parent`, which is right only when
// the parent is itself top-level. Answering somebody's reply to you (report 3)
// is the case where it is not.
//
// So an absent root is not "the parent is the root": it is "we do not know",
// and we ask the network. The public AppView's getPosts returns the parent's
// own record, whose `reply.root` is the answer; a record with no `reply` is
// top-level and IS its own root. Nothing has been written yet when this runs,
// so the split is the ordinary one — a 4xx (bar 429) or a post the AppView no
// longer has is terminal, anything else is ambiguous and the job retries.
// =============================================================================

const APPVIEW = "https://public.api.bsky.app";

interface StrongRef {
  uri: string;
  cid: string;
}

export async function resolveBlueskyReplyRoot(parent: {
  uri: string;
  cid: string;
  rootUri?: string;
  rootCid?: string;
}): Promise<StrongRef> {
  if (parent.rootUri && parent.rootCid) {
    return { uri: parent.rootUri, cid: parent.rootCid };
  }

  const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
  url.searchParams.append("uris", parent.uri);
  const res = await safeFetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const detail = `Bluesky getPosts HTTP ${res.status}: ${res.text.slice(0, 200)}`;
    if (isTerminalHttpStatus(res.status)) throw new TerminalDeliveryError(detail);
    throw new Error(detail);
  }

  const data = JSON.parse(res.text) as {
    posts?: {
      uri: string;
      cid: string;
      record?: { reply?: { root?: { uri?: string; cid?: string } } };
    }[];
  };
  const post = data.posts?.find((p) => p.uri === parent.uri);
  if (!post) {
    throw new TerminalDeliveryError(
      "The Bluesky post you replied to could not be found — it may have been deleted",
    );
  }
  const root = post.record?.reply?.root;
  if (root?.uri && root.cid) return { uri: root.uri, cid: root.cid };
  // A reply record whose root is malformed is not a top-level post: guessing
  // `root = parent` here is the bug this module exists to remove.
  if (post.record?.reply) {
    throw new TerminalDeliveryError(
      "The Bluesky post you replied to has a malformed thread reference",
    );
  }
  return { uri: post.uri, cid: post.cid };
}
