import type { AddWorkspaceFeedSourceInput, ResolverMatch } from "../api";

export interface MatchOption {
  key: string;
  label: string;
  sublabel: string | null;
  add: AddWorkspaceFeedSourceInput;
  confidence?: ResolverMatch["confidence"];
  /** Present on native_account options — the resolved account's identity, for
   *  surfaces that act on a person (DM, invite, fee override) rather than add
   *  a feed source. */
  account?: { id: string; username: string; displayName: string };
}

export function matchToOptions(match: ResolverMatch): MatchOption[] {
  const out: MatchOption[] = [];
  if (match.type === "native_account" && match.account) {
    out.push({
      key: `acc:${match.account.id}`,
      label: match.account.displayName || `@${match.account.username}`,
      sublabel: match.account.username ? `@${match.account.username}` : null,
      add: { sourceType: "account", accountId: match.account.id },
      confidence: match.confidence,
      account: {
        id: match.account.id,
        username: match.account.username,
        displayName: match.account.displayName,
      },
    });
  }
  if (match.type === "external_source" && match.externalSource) {
    const x = match.externalSource;
    out.push({
      key: `xs:${x.protocol}:${x.sourceUri}`,
      label: x.displayName || x.sourceUri,
      sublabel: x.protocol,
      add: {
        sourceType: "external_source",
        protocol: x.protocol as
          | "rss"
          | "atproto"
          | "activitypub"
          | "nostr_external",
        sourceUri: x.sourceUri,
        displayName: x.displayName,
        description: x.description,
        avatarUrl: x.avatar,
        relayUrls: x.relayUrls,
      },
      confidence: match.confidence,
    });
  }
  if (match.type === "rss_feed" && match.rssFeed) {
    out.push({
      key: `rss:${match.rssFeed.feedUrl}`,
      label: match.rssFeed.title || match.rssFeed.feedUrl,
      sublabel: "rss",
      add: {
        sourceType: "external_source",
        protocol: "rss",
        sourceUri: match.rssFeed.feedUrl,
        displayName: match.rssFeed.title,
        description: match.rssFeed.description,
      },
      confidence: match.confidence,
    });
  }
  return out;
}

export function tagFallback(query: string): MatchOption | null {
  const trimmed = query.trim();
  if (!trimmed.startsWith("#") || trimmed.length < 2) return null;
  const tagName = trimmed.slice(1).trim().replace(/\s+/g, "-").toLowerCase();
  if (!tagName) return null;
  return {
    key: `tag:${tagName}`,
    label: `#${tagName}`,
    sublabel: "tag",
    add: { sourceType: "tag", tagName },
    confidence: "exact",
  };
}

export function resolveMatches(
  query: string,
  matches: ResolverMatch[],
): MatchOption[] {
  const items = matches.flatMap(matchToOptions);
  const fallback = tagFallback(query);
  if (fallback && !items.some((m) => m.key === fallback.key)) {
    return [...items, fallback];
  }
  return items;
}

// Rendered confidence tiers (RESOLVER-DISCOVERY-ADR §6.4, audit F3): the match
// well splits into "Matches" (exact + probable — verified identifiers and
// platform-held known-world identities) and "Suggestions" (speculative
// discovery nominations). Partitioned once here so the three consumer surfaces
// just render two lists; an option with no confidence (older gateway rows)
// counts as a match. Server ordering (§6.2) is preserved within each section.
export interface MatchSections {
  matches: MatchOption[];
  suggestions: MatchOption[];
}

export function partitionMatchOptions(options: MatchOption[]): MatchSections {
  const matches: MatchOption[] = [];
  const suggestions: MatchOption[] = [];
  for (const o of options) {
    (o.confidence === "speculative" ? suggestions : matches).push(o);
  }
  return { matches, suggestions };
}
