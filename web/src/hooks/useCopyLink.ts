"use client";

import { useCallback, useState } from "react";

// =============================================================================
// useCopyLink — the id-keyed copy affordance, in one home.
//
// The rule this implements is in `web/CLAUDE.md` › *An action whose product is
// a link is ONE button…*, and the middle clause is the one that needs a shared
// implementation: **`await` the write and confirm only if it resolved.** The
// shape it replaces — `void navigator.clipboard.writeText(url)` followed by an
// unconditional `setCopiedId(id)` — claims a copy it never checked, and the
// write really is rejected in practice: by permissions policy, in a non-secure
// context, and by Safari whenever the call sits too far from the user gesture.
// The label then reads "Copied!" every time and the clipboard holds whatever it
// held before, which the reader discovers by pasting the wrong thing into a
// message they are about to send.
//
// And a rejected write **reveals the value** (`failed`), because saying
// "copied" without copying is the worst outcome available here and silence is
// only slightly better. The caller renders that reveal itself — the shape of
// "show the URL to be taken by hand" is different in a table cell than in a
// panel, so the hook owns the discipline and not the markup.
//
// SCOPED TO A LIST OF LINKS THE CALLER ALREADY HOLDS, which is why it is keyed
// by id: several rows, one at a time, each with its own transient confirmation.
// The share control (`FeedFormulaSection`) deliberately does NOT use it — it is
// the other shape, an action that PRODUCES a link, where the URL does not exist
// until a mint has been awaited and there is no id to key on. Same discipline,
// different lifecycle; do not force one through the other.
// =============================================================================

/** How long a confirmation stays on the label. */
const CONFIRM_MS = 2000;

export type CopyOutcome = { ok: true } | { ok: false; url: string };

/**
 * Attempt the write and say what actually happened.
 *
 * Pure and injectable, so the one thing that matters here is testable without a
 * renderer: **a rejected write must never report success.** The bug this
 * replaces was `void navigator.clipboard.writeText(url)` followed by an
 * unconditional confirmation — which is green against a rejecting clipboard,
 * because nothing ever looked. Mutate `await write(url)` to `void write(url)`
 * and the rejection case below goes red; that is the whole point of the split.
 */
export async function copyOrReveal(
  url: string,
  write: (text: string) => Promise<void>,
): Promise<CopyOutcome> {
  try {
    await write(url);
    return { ok: true };
  } catch {
    return { ok: false, url };
  }
}

export interface CopyLinkState {
  /** The row whose copy just succeeded, or null. */
  copiedId: string | null;
  /** The row whose copy was REFUSED, or null. Render the url beside it. */
  failedId: string | null;
  /** The url that could not be copied, for the caller to reveal. */
  failedUrl: string | null;
  copy: (id: string, url: string) => Promise<void>;
}

export function useCopyLink(): CopyLinkState {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const copy = useCallback(async (id: string, url: string) => {
    // Any previous row's state clears first: two rows both claiming to be the
    // one on the clipboard is the same lie in a different shape.
    setCopiedId(null);
    setFailedId(null);
    setFailedUrl(null);
    const outcome = await copyOrReveal(url, (t) =>
      navigator.clipboard.writeText(t),
    );
    if (outcome.ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), CONFIRM_MS);
      return;
    }
    // No timeout on the failure: the reveal is the reader's only route to the
    // value, so it stays until they copy another row or leave.
    setFailedId(id);
    setFailedUrl(outcome.url);
  }, []);

  return { copiedId, failedId, failedUrl, copy };
}
