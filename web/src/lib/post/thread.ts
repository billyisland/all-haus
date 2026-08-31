// =============================================================================
// Thread derivation — UNIVERSAL-POST-ADR §4.3 / §8
//
// One pure walk over a Post pool + a focalId yields the three render bands the
// thread engine paints: ancestors (above, root-first), the focal, and
// descendants (below, chronological flatten). This is the client side of the
// "one read, then client-side re-root" model (§8): re-rooting onto any node
// already in the pool is just calling this with a new focalId — no refetch.
//
// PURE: no React, no fetches. Unit-tested in thread.test.ts.
// =============================================================================

import type { Post } from "./types";

export interface ThreadView {
  focal: Post;
  // Oldest-first: root … focal's immediate parent. Walks Post.inReplyTo up.
  ancestors: Post[];
  // The focal's transitive subtree, flattened by (publishedAt, id) ascending —
  // matching the server's chronological flatten + keyset pagination order so
  // appended pages merge in place.
  descendants: Post[];
}

// Compare by (publishedAt asc, id asc) — the server's descendant ordering.
function chrono(a: Post, b: Post): number {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt - b.publishedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function deriveThreadView(
  pool: Map<string, Post>,
  focalId: string,
): ThreadView | null {
  const focal = pool.get(focalId);
  if (!focal) return null;

  // Ancestors — walk parents to the root, cycle-guarded. Stops at the first
  // link that points outside the pool (a gap); the caller fetches to fill it.
  const ancestors: Post[] = [];
  const seen = new Set<string>([focalId]);
  let cur = focal.inReplyTo ? pool.get(focal.inReplyTo) : undefined;
  while (cur && !seen.has(cur.id)) {
    ancestors.push(cur);
    seen.add(cur.id);
    cur = cur.inReplyTo ? pool.get(cur.inReplyTo) : undefined;
  }
  ancestors.reverse(); // root-first

  // Descendants — collect the transitive subtree, then flatten chronologically.
  const childrenOf = new Map<string, Post[]>();
  for (const p of pool.values()) {
    if (!p.inReplyTo) continue;
    const arr = childrenOf.get(p.inReplyTo);
    if (arr) arr.push(p);
    else childrenOf.set(p.inReplyTo, [p]);
  }
  const descendants: Post[] = [];
  const visited = new Set<string>();
  const stack = [...(childrenOf.get(focalId) ?? [])];
  while (stack.length) {
    const node = stack.pop()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    descendants.push(node);
    const kids = childrenOf.get(node.id);
    if (kids) stack.push(...kids);
  }
  descendants.sort(chrono);

  return { focal, ancestors, descendants };
}
