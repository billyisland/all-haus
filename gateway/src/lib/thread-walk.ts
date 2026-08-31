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
