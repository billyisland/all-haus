// Pure thread-walk helpers for the /thread projector. Kept dependency-free so
// they're unit-testable without loading the route's DB / service imports.

// Flatten the subtree under `focalPostId` from a parent-post-id → children
// adjacency map, depth-first.
//
// The `seen` set is a cycle guard (UNIVERSAL-POST P0-2): on well-formed data each
// node appears under exactly one parent, so it never fires and every node is
// emitted once; on corrupt cyclic `parent_comment_id` data it terminates the walk
// instead of recursing unboundedly (which would hang the request for every reader
// of the conversation). Mirrors the ancestor walk's guard in assembleNativeThread.
export function collectDescendants<T extends { derived_post_id: string }>(
  focalPostId: string,
  childrenOf: Map<string, T[]>,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string) => {
    if (seen.has(parentId)) return;
    seen.add(parentId);
    for (const k of childrenOf.get(parentId) ?? []) {
      out.push(k);
      walk(k.derived_post_id);
    }
  };
  walk(focalPostId);
  return out;
}

// The article foot's resting shape: the conversation's DIRECT replies, ranked
// by how much conversation hangs off each, each carrying the first few of its
// own direct replies as previews. Everything below a preview is reached by
// opening that reply's conversation, which reads the ordinary /thread.
//
// `counted` is the projector's own "is this node in the conversation" test
// (hidden authors out, tombstones in — a deleted remark's replies keep their
// context), so a count here agrees with `totalDescendants` for the same node.
// `shown` is stricter and decides what may stand on its OWN at rest: a
// top-level reply or a preview by a hidden author is dropped unless it has
// counted replies beneath it, which it is the only way to reach. A TOMBSTONE
// is kept: a reply its author deletes must come back as `[deleted]` in the
// place it stood, as it does in every other conversation — dropped, a refresh
// could not tell it from a reply that had merely moved out of the page.
//
// Ranked by count, most first; ties go NEWEST first, so a fresh reply is not
// buried under every older one that also has none. Previews are chronological.
export interface RankedTopLevel<T> {
  node: T;
  count: number;
  previews: T[];
}
export function rankTopLevel<
  T extends { derived_post_id: string; published_at_epoch: number; id: string },
>(
  rootPostId: string,
  childrenOf: Map<string, T[]>,
  counted: (c: T) => boolean,
  shown: (c: T) => boolean,
  previewCount: number,
): RankedTopLevel<T>[] {
  const countOf = (id: string) =>
    collectDescendants(id, childrenOf).filter(counted).length;
  const chrono = (a: T, b: T) =>
    a.published_at_epoch - b.published_at_epoch || (a.id < b.id ? -1 : 1);

  const ranked: RankedTopLevel<T>[] = [];
  for (const node of childrenOf.get(rootPostId) ?? []) {
    const count = countOf(node.derived_post_id);
    if (!shown(node) && count === 0) continue;
    const previews = [...(childrenOf.get(node.derived_post_id) ?? [])]
      .filter((c) => shown(c) || countOf(c.derived_post_id) > 0)
      .sort(chrono)
      .slice(0, previewCount);
    ranked.push({ node, count, previews });
  }
  ranked.sort(
    (a, b) =>
      b.count - a.count ||
      b.node.published_at_epoch - a.node.published_at_epoch ||
      (a.node.id < b.node.id ? -1 : 1),
  );
  return ranked;
}
