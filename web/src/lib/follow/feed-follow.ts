import type {
  WorkspaceFeedSource,
  AddWorkspaceFeedSourceInput,
} from "../api/feeds";
import type { AuthorCardData } from "../../hooks/useAuthorCard";

// =============================================================================
// The pure half of "follow this author/source into a feed" — the full site's
// `useFeedFollow` and modernhaus's `follow` / `unfollow_everywhere` actions
// both build the add payload and match membership HERE, so the two registers
// send the route the same thing. The rule behind it is `useFeedFollow.ts`'s
// header (a follow is FEED-DERIVED; the route writes the graph row).
// =============================================================================

export type FeedFollowTarget = NonNullable<AuthorCardData["followTarget"]>;

// Protocols the workspace addSource path can service. Email is ingest-only, so
// an email source has no follow gesture at all.
//
// A RUNTIME ARRAY WITH THE TYPE DERIVED FROM IT, never a bare union: these
// strings cross the web↔gateway boundary into `addSourceSchema`'s own
// `z.enum`, there is no module path between the two workspaces, and a type
// can be compared against nothing at test time. `web/tests/
// follow-feed-frontier.test.ts` reads the gateway source and pins them.
export const FOLLOWABLE_PROTOCOLS = [
  "rss",
  "atproto",
  "activitypub",
  "nostr_external",
] as const;

export type ExternalProtocol = (typeof FOLLOWABLE_PROTOCOLS)[number];

/** A native writer is always followable; an external source only over a
 *  protocol `addSource` can service. */
export function isFeedFollowable(target: FeedFollowTarget): boolean {
  if (target.type === "user") return true;
  if (!target.protocol) return true;
  return (FOLLOWABLE_PROTOCOLS as readonly string[]).includes(target.protocol);
}

/** The `feed_sources` row id holding this target in a feed, else null.
 *  Exported because the feed-SCOPED button (the hover card inside a vessel,
 *  where the context decides and there is no menu) must match and add by the
 *  same rule the picker does. */
export function matchFeedSource(
  sources: WorkspaceFeedSource[],
  target: FeedFollowTarget,
): string | null {
  if (target.type === "user") {
    return (
      sources.find(
        (s) => s.sourceType === "account" && s.accountId === target.id,
      )?.id ?? null
    );
  }
  if (!target.sourceId) return null;
  return (
    sources.find(
      (s) =>
        s.sourceType === "external_source" &&
        s.externalSourceId === target.sourceId,
    )?.id ?? null
  );
}

/** The add payload, or null where the target carries too little to add with.
 *  Never gate a REMOVAL on this — removal needs only the row id, and gating it
 *  on the add-only fields is how an unfollow silently no-ops. */
export function feedFollowAddInput(
  target: FeedFollowTarget,
): AddWorkspaceFeedSourceInput | null {
  if (target.type === "user") {
    return { sourceType: "account", accountId: target.id };
  }
  if (target.protocol && target.sourceUri) {
    return {
      sourceType: "external_source",
      protocol: target.protocol as ExternalProtocol,
      sourceUri: target.sourceUri,
    };
  }
  return null;
}
