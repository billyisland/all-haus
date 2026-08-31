import { describe, it, expect } from "vitest";
import { copyOrReveal } from "./useCopyLink";

// =============================================================================
// The one thing that matters about a copy affordance: it must not claim a copy
// it never made (web/CLAUDE.md › *An action whose product is a link is ONE
// button…*).
//
// The shape this replaces — `void navigator.clipboard.writeText(url)` then an
// unconditional `setCopiedId(id)` — is GREEN against a clipboard that rejects
// every call, because nothing ever looked at the result. So the assertions
// below are about the REJECTION path; the success path is the easy half and is
// here only as its control.
//
// Rejection is not hypothetical: the write is refused by permissions policy, in
// a non-secure context, and by Safari whenever the call sits too far from the
// user gesture — and in every one of those the old label read "Copied!" while
// the clipboard held whatever it held before.
// =============================================================================

describe("copyOrReveal — never claim a copy that did not happen", () => {
  it("reports success when the write resolves", async () => {
    const seen: string[] = [];
    const out = await copyOrReveal("https://all.haus/f/tok", async (t) => {
      seen.push(t);
    });
    expect(out).toEqual({ ok: true });
    // The url reaches the clipboard verbatim — a copy affordance that
    // transformed it would be a different bug in the same place.
    expect(seen).toEqual(["https://all.haus/f/tok"]);
  });

  it("reports FAILURE when the write rejects, and hands back the url to reveal", async () => {
    // The mutation this catches: `await write(url)` → `void write(url)`. That
    // version returns { ok: true } here and the surface says "Copied!" against
    // a clipboard it never wrote to.
    const out = await copyOrReveal("https://all.haus/f/tok", () =>
      Promise.reject(new Error("NotAllowedError")),
    );
    expect(out.ok).toBe(false);
    // Saying "copied" without copying is the worst outcome available; silence
    // is only slightly better. The url comes back so the caller can show it.
    if (!out.ok) expect(out.url).toBe("https://all.haus/f/tok");
  });

  it("reports failure when the write THROWS synchronously", async () => {
    // `navigator.clipboard` is undefined in an insecure context, so the call
    // throws rather than rejecting — a distinct path, and the one an http://
    // staging origin actually takes.
    const out = await copyOrReveal("https://all.haus/f/tok", () => {
      throw new TypeError("navigator.clipboard is undefined");
    });
    expect(out.ok).toBe(false);
  });
});
