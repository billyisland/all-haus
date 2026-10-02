// =============================================================================
// Bluesky strong refs for external_items.interaction_data — ONE home
// (CROSS-NETWORK-ROUNDTRIP-ADR F6 / A8).
//
// A reply to a Bluesky post has to name TWO records: the post it answers
// (`parent`) and the top of that post's thread (`root`). The outbound worker
// builds both from the parent row's interaction_data — `uri`/`cid` for the
// parent, `rootUri`/`rootCid` for the root — and where the root is absent it
// can only assume the parent IS the root. That assumption is right for a
// top-level post and wrong for every reply, so a row stored as bare
// `{uri, cid}` made each answer to a reply go out with the wrong thread root.
//
// Real ingest (feed-ingest/src/adapters/atproto.ts) always carried the four
// reply keys. The seven CONTEXT writes — hydration, author-timeline hydration,
// the thread focus fetch, both parent fetchers, both quote fetchers — stored
// `{uri, cid}` alone, although the record they had in hand carried
// `reply.root`. Those are exactly the rows a member answers when they reply to
// somebody's reply, so every context write builds its interaction_data here.
//
// Keys are OMITTED rather than set undefined/null for a top-level post:
// CONTEXT_INTERACTION_MERGE_SQL is a jsonb `||` with the new side winning, so
// an explicit null would erase a real row's root.
// =============================================================================

export interface AtprotoStrongRef {
  uri: string;
  cid?: string;
}

export interface AtprotoReplyRefs {
  parent: AtprotoStrongRef;
  root: AtprotoStrongRef;
}

export function blueskyInteractionData(post: {
  uri: string;
  cid: string;
  record?: { reply?: AtprotoReplyRefs } | null;
}): Record<string, string> {
  const out: Record<string, string> = { uri: post.uri, cid: post.cid };
  const reply = post.record?.reply;
  if (reply?.root?.uri) {
    out.rootUri = reply.root.uri;
    if (reply.root.cid) out.rootCid = reply.root.cid;
  }
  if (reply?.parent?.uri) {
    out.parentUri = reply.parent.uri;
    if (reply.parent.cid) out.parentCid = reply.parent.cid;
  }
  return out;
}
