import { describe, it, expect } from "vitest";
import { copyOrReveal, copyPendingOrReveal } from "./useCopyLink";

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

// =============================================================================
// copyPendingOrReveal — the copy must ride the gesture, and must still never
// claim a copy it did not make (§0u.5).
//
// The bug this closes is invisible to a test that only checks the outcome: on
// WebKit the LATE write is refused because the gesture is spent, and the only
// thing that distinguishes the fix from the bug is WHEN the clipboard was
// called. So the first assertion below is about ordering, not about a result.
// =============================================================================

describe("copyPendingOrReveal — spend the gesture, not the round trip", () => {
  it("calls the pending writer SYNCHRONOUSLY, before the value resolves", () => {
    // The mutation this catches: awaiting the mint and then writing. That
    // version leaves `called` false at this point in the tick, which is
    // precisely the state in which Safari has already revoked the clipboard.
    let called = false;
    let resolveMint: (u: string) => void = () => {};
    const pending = new Promise<string>((r) => {
      resolveMint = r;
    });
    void copyPendingOrReveal(pending, {
      writePending: () => {
        called = true;
        return Promise.resolve();
      },
      writeText: async () => {},
    });
    expect(called).toBe(true);
    resolveMint("https://all.haus/f/tok");
  });

  it("reports success from the pending write without a second write", async () => {
    const late: string[] = [];
    const out = await copyPendingOrReveal(
      Promise.resolve("https://all.haus/f/tok"),
      {
        writePending: () => Promise.resolve(),
        writeText: async (t) => {
          late.push(t);
        },
      },
    );
    expect(out).toEqual({ ok: true });
    // A browser that took the promise must not be written to twice — the
    // second write is a second clipboard mutation, not a confirmation.
    expect(late).toEqual([]);
  });

  it("falls back to the late write when there is no pending writer", async () => {
    const late: string[] = [];
    const out = await copyPendingOrReveal(
      Promise.resolve("https://all.haus/f/tok"),
      {
        writePending: null,
        writeText: async (t) => {
          late.push(t);
        },
      },
    );
    expect(out).toEqual({ ok: true });
    expect(late).toEqual(["https://all.haus/f/tok"]);
  });

  it("falls back to the late write when the pending write is REFUSED", async () => {
    // Firefox and any browser without promise-valued ClipboardItem support
    // land here, and the late write is a real second chance for them.
    const late: string[] = [];
    const out = await copyPendingOrReveal(
      Promise.resolve("https://all.haus/f/tok"),
      {
        writePending: () => Promise.reject(new Error("NotAllowedError")),
        writeText: async (t) => {
          late.push(t);
        },
      },
    );
    expect(out).toEqual({ ok: true });
    expect(late).toEqual(["https://all.haus/f/tok"]);
  });

  it("falls back when the pending writer THROWS synchronously", async () => {
    const late: string[] = [];
    const out = await copyPendingOrReveal(
      Promise.resolve("https://all.haus/f/tok"),
      {
        writePending: () => {
          throw new TypeError("ClipboardItem is not defined");
        },
        writeText: async (t) => {
          late.push(t);
        },
      },
    );
    expect(out).toEqual({ ok: true });
    expect(late).toEqual(["https://all.haus/f/tok"]);
  });

  it("reveals when BOTH writes are refused", async () => {
    const out = await copyPendingOrReveal(
      Promise.resolve("https://all.haus/f/tok"),
      {
        writePending: () => Promise.reject(new Error("NotAllowedError")),
        writeText: () => Promise.reject(new Error("NotAllowedError")),
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.url).toBe("https://all.haus/f/tok");
  });

  it("propagates a failed mint, and does not leave the pending write unhandled", async () => {
    // The caller reports the mint error; what must NOT happen is the derived
    // clipboard promise rejecting with nobody listening. `attempt.catch(() =>
    // {})` is what makes this pass — remove it and this test raises an
    // unhandled rejection.
    const err = new Error("mint failed");
    await expect(
      copyPendingOrReveal(Promise.reject(err), {
        writePending: (p) => p.then(() => undefined),
        writeText: async () => {},
      }),
    ).rejects.toBe(err);
    // Give the microtask queue a turn so an unhandled rejection would surface.
    await new Promise((r) => setTimeout(r, 0));
  });
});
