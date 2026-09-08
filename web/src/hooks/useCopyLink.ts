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
// SCOPED TO A LIST OF LINKS THE CALLER ALREADY HOLDS, which is why the HOOK is
// keyed by id: several rows, one at a time, each with its own transient
// confirmation. The share control (`FeedFormulaSection`) is the other shape —
// an action that PRODUCES a link, where the URL does not exist until a mint has
// been awaited and there is no id to key on — so it does not use the hook. It
// does use the two exported functions below, because the discipline is one
// discipline and a third hand-rolled copy of it had already drifted (§0u.5).
// =============================================================================

/** How long a confirmation stays on the label. Exported because the share
 *  control shows the same confirmation and a second literal is a second
 *  answer — the drift this replaces was 2400 against 2000. */
export const CONFIRM_MS = 2000;

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

/**
 * Copy a URL THAT DOES NOT EXIST YET, without spending the user gesture.
 *
 * The whole difficulty is WebKit's transient user activation. Safari grants the
 * clipboard to a handler for a short window after the click, and an `await` in
 * between routinely spends it — so `const url = await mint(); await
 * writeText(url)` is refused on Safari not occasionally but as its ordinary
 * behaviour, and "press it, the link is copied" degrades to the reveal fallback
 * every time. That is the exact failure `copyOrReveal`'s own header names, and
 * the share control had it by construction because its URL is a mint away.
 *
 * The sanctioned pattern is to hand the clipboard the PROMISE: construct a
 * `ClipboardItem` whose `text/plain` value is the pending value and call
 * `navigator.clipboard.write` synchronously, inside the gesture, before
 * anything is awaited. Safari holds the write open until the promise settles.
 *
 * `writePending` is therefore called SYNCHRONOUSLY — every caller must reach
 * this function with the gesture still live, and this function must not await
 * before calling it. Everything after is ordinary async.
 *
 * FALLS BACK RATHER THAN REQUIRING IT. Promise-valued `ClipboardItem` is not
 * universal (a caller passes `writePending: null` where the API is absent), and
 * where it is present it can still be refused. Either way the late `writeText`
 * runs against the resolved value and `copyOrReveal` decides the outcome — so
 * the rule that survives everything is the one this module exists for: never
 * report a copy that did not happen.
 *
 * Injectable for the same reason `copyOrReveal` is: the branch that matters is
 * "the pending write was refused, so the late write decides", and no renderer
 * or real clipboard is needed to drive it.
 */
export async function copyPendingOrReveal(
  pending: Promise<string>,
  writers: {
    /** Called synchronously with the pending text. Null where the browser has
     *  no promise-valued clipboard write. */
    writePending: ((text: Promise<string>) => Promise<void>) | null;
    /** Called with the resolved text when the pending write is absent or was
     *  refused. */
    writeText: (text: string) => Promise<void>;
  },
): Promise<CopyOutcome> {
  let attempt: Promise<void> | null = null;
  if (writers.writePending) {
    try {
      attempt = writers.writePending(pending);
      // Marked handled the moment it exists. `pending` may reject — the mint
      // failed — in which case this rejects too and the caller never reaches
      // the await below, so without this the failure surfaces as an unhandled
      // rejection on top of the error the caller is already reporting.
      attempt.catch(() => {});
    } catch {
      // A synchronous throw (no `ClipboardItem`, an insecure context) is the
      // same answer as a refusal: fall through to the late write.
      attempt = null;
    }
  }
  // Awaited unconditionally: the caller needs the value regardless of how the
  // copy went, and a rejection here is the caller's error to report.
  const url = await pending;
  if (attempt) {
    try {
      await attempt;
      return { ok: true };
    } catch {
      // Refused after all — the late write is a real second chance on every
      // browser that is not the one this branch exists for.
    }
  }
  return copyOrReveal(url, writers.writeText);
}

/**
 * The browser wiring for `copyPendingOrReveal`, in one place.
 *
 * Feature-detected rather than sniffed: `ClipboardItem` is what the pattern
 * needs, so its presence is the honest question. Returns null where it is
 * absent, which is exactly what `writePending: null` means.
 */
export function pendingClipboardWriter():
  | ((text: Promise<string>) => Promise<void>)
  | null {
  if (typeof ClipboardItem === "undefined") return null;
  if (typeof navigator === "undefined" || !navigator.clipboard?.write)
    return null;
  return (text) =>
    navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })),
      }),
    ]);
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
