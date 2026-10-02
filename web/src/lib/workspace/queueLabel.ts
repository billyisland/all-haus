import type { FeedSeenCounts } from "../../stores/feedSeen";

// The accessible name of a queue line or a compact bar (WORKSPACE-QUEUE-ADR
// §VI.1, §VII.4): the feed, then its counts — "Feed 3: Philosophy, 2 new,
// 8 unread". A line shows nothing but its colour, so this is the whole of what
// it says to anyone who cannot see it.
//
// The counts read as the pills do: a figure at 0 is left out, a truncated one
// reads "500+", and with no window yet there are no counts at all, because a
// 0 before the first window would be a claim (§IV.5).

export function queueFeedName(numeral: number, name: string): string {
  return name ? `Channel ${numeral}: ${name}` : `Channel ${numeral}`;
}

export function queueCountedName(
  base: string,
  counts: FeedSeenCounts | null,
): string {
  if (!counts) return base;
  const parts: string[] = [];
  if (counts.new > 0)
    parts.push(`${counts.new}${counts.newTruncated ? "+" : ""} new`);
  if (counts.unread > 0)
    parts.push(`${counts.unread}${counts.truncated ? "+" : ""} unread`);
  return parts.length > 0
    ? `${base}, ${parts.join(", ")}`
    : `${base}, nothing unread`;
}
