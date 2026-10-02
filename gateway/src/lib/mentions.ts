// =============================================================================
// @mention scanning — one home, and it agrees with the HANDLE COLUMN.
//
// Two routes notify the people a body names (`POST /notes`, `POST /replies`).
// Both had their own copy of the scan, and both copies STOPPED AT A HYPHEN
// (`/@([a-zA-Z0-9_]+)/`) — which `USERNAME_RE` has always allowed inside a
// handle. `deriveUsername` disambiguates a collision by appending `-` + 6 hex
// characters, so the hyphenated handle is not an edge case — it is what every
// member who arrived after a name collision, or with a name under three
// characters, is called.
//
// And it did not merely MISS them. `@blue-a1b2c3` captured `blue`, so a mention
// of the disambiguated account notified the account it was disambiguated FROM:
// the one member on the platform most likely to be mistaken for them anyway.
// That is the shape of the fix — a mention resolves to the whole handle, or to
// nobody, and never to a neighbour.
//
// THE TRAILING-HYPHEN RULE. A hyphen is legal inside a handle and ordinary in
// prose, so the greedy token is a guess in both directions: `@blue-a1b2c3` must
// keep its suffix, while `@blue-` and `@blue-please-look` must lose theirs. The
// walk resolves it from the ACCOUNTS TABLE rather than from the prose: take the
// longest candidate, drop one `-segment` at a time, and stop at the first
// candidate that NAMES A ROW.
//
// "Names a row" is deliberately not "names a notifiable row". The walk stops on
// any status — suspended, deactivated, deleted — because a handle that is TAKEN
// is an answer: it says the writer meant that account, and we simply have
// nobody to tell. Stopping only on active rows would walk PAST a suspended
// `blue-a1b2c3` and notify `blue`, which is the original bug restored for the
// one case where it is least excusable. `accounts.username` survives deletion
// (`POST /auth/delete-account` clears the email and the profile, not the
// handle), so a deleted account still answers for its name.
//
// WHAT A HANDLE *IS* FOR A LOOKUP IS NOT WHAT A HANDLE IS FOR A MINT, and
// conflating the two is how the first version of this file broke a case it was
// written to protect. `USERNAME_RE` says what we will CREATE: lowercase
// alphanumerics with interior hyphens, no underscore. `accounts.username` holds
// something slightly wider, because handles minted before that rule was hoisted
// into one home carry interior UNDERSCORES (the dev database has 19 of them out
// of 150, and prod is the operator's to check — see FIX-PROGRAMME). Filtering
// candidates through the MINT rule made every one of those unmentionable, which
// is the same fault as the hyphen in the other direction: a scan that disagrees
// with the column it searches.
//
// So `HANDLE_RE` below is `USERNAME_RE` widened by that one character, and it is
// what candidates are filtered by. Nothing else changes: a handle is still
// matched WHOLE, the walk still splits on hyphens alone (an underscore carries
// no such convention and is never a place a token might end), and the trailing
// trim takes both, because neither can end a real handle. The relationship is
// pinned by a test rather than left as a comment, so relaxing the mint rule
// without widening the lookup fails rather than going quiet.
//
// THE LOOKBEHIND IS UNCHANGED, DELIBERATELY. An `@` preceded by an
// alphanumeric or a dot is part of an ADDRESS — `reader@heron.example` must not
// notify `heron` — and widening that class to the rest of an email local part
// (`_ % + -`) was written here and then taken back out: no test could tell the
// two apart, because a local part ending in one of those characters is not a
// thing anybody writes, while `@heron-@blue` — where the wider class DOES bite
// — is a writer naming two people and being heard to name one.
// =============================================================================

interface QueryClient {
  query: <R extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[] }>;
}

export const MENTION_RE = /(?<![A-Za-z0-9.])@([A-Za-z0-9_-]{1,64})/g;

/** What `accounts.username` can actually hold: `USERNAME_RE` widened by the
 *  interior underscore legacy rows carry. Exported for the test that pins it
 *  against the mint rule. */
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/;

/**
 * The candidate handles a body names, one list per distinct mention token,
 * each list ordered LONGEST FIRST and filtered to strings the username column
 * could hold at all (`HANDLE_RE`, which is where the 3-30 floor comes from —
 * `@ed-a1b2c3` yields `ed-a1b2c3` and not the two-character `ed`).
 *
 * Case is folded here because handles are stored lowercase and every lookup on
 * the platform is a bare `WHERE username = $1`: `@BlueJay` matched nothing at
 * all before, which reads to the writer exactly like a mention that worked.
 */
export function mentionCandidates(content: string): string[][] {
  const seen = new Set<string>();
  const lists: string[][] = [];
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(content)) !== null) {
    const token = match[1].toLowerCase().replace(/[-_]+$/, "");
    if (!token || seen.has(token)) continue;
    seen.add(token);
    const candidates: string[] = [];
    let candidate = token;
    while (candidate) {
      if (HANDLE_RE.test(candidate)) candidates.push(candidate);
      const cut = candidate.lastIndexOf("-");
      if (cut === -1) break;
      candidate = candidate.slice(0, cut).replace(/[-_]+$/, "");
    }
    if (candidates.length > 0) lists.push(candidates);
  }
  return lists;
}

/**
 * The accounts to notify for a body: active, not the author, deduped.
 *
 * One query for every candidate of every token — the walk is decided in memory
 * afterwards, because the rule ("the first handle that is TAKEN settles the
 * token") cannot be written as a filter without losing the taken-but-silent
 * case the header describes.
 */
export async function resolveMentionedAccountIds(
  client: QueryClient,
  content: string,
  authorId: string,
): Promise<string[]> {
  const lists = mentionCandidates(content);
  if (lists.length === 0) return [];

  const { rows } = await client.query<{
    id: string;
    username: string;
    status: string;
  }>(`SELECT id, username, status FROM accounts WHERE username = ANY($1)`, [
    [...new Set(lists.flat())],
  ]);
  const taken = new Map(rows.map((r) => [r.username, r]));

  const ids = new Set<string>();
  for (const candidates of lists) {
    for (const candidate of candidates) {
      const row = taken.get(candidate);
      if (!row) continue;
      if (row.status === "active" && row.id !== authorId) ids.add(row.id);
      break;
    }
  }
  return [...ids];
}
