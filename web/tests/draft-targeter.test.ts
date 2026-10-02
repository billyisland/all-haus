import { describe, it, expect } from "vitest";
import { createDraftTargeter, type DraftData, type SavedDraft } from "../src/lib/drafts";

// =============================================================================
// A new piece's first save mints ITS OWN row, and a save racing it lands there.
//
// Without an id or a dTag, `POST /drafts` guesses "the writer's most recent
// untagged draft", which overwrote an unrelated piece whenever one existed
// (MODERNHAUS-ADR §E4.3). The guess was there to stop an autosave and an
// explicit Save both inserting; the targeter closes that race on the client.
//
// MUTATIONS: (1) drop `newDraft` from the first save ⇒ case 1 fails; (2) drop
// the wait on the in-flight first save ⇒ case 2 sends two `newDraft` saves;
// (3) keep a failed first save as the target ⇒ case 3 never mints again.
// =============================================================================

const BASE: DraftData = { title: "T", content: "c", gatePositionPct: 50, pricePence: 0 };

function rig() {
  const sent: DraftData[] = [];
  const pending: Array<{ resolve: (d: SavedDraft) => void; reject: (e: Error) => void }> = [];
  const save = (d: DraftData) => {
    sent.push(d);
    return new Promise<SavedDraft>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { sent, pending, targeted: createDraftTargeter(save) };
}
const saved = (id: string): SavedDraft => ({ draftId: id, autoSavedAt: "now", scheduledAt: null });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createDraftTargeter", () => {
  it("asks for a row of its own on a new piece's first save", async () => {
    const { sent, pending, targeted } = rig();
    const p = targeted(BASE);
    pending[0].resolve(saved("row-1"));
    await expect(p).resolves.toEqual(saved("row-1"));
    expect(sent[0].newDraft).toBe(true);
    expect(sent[0].draftId).toBeUndefined();
  });

  it("sends a save that races the first onto the row the first made", async () => {
    const { sent, pending, targeted } = rig();
    const first = targeted(BASE);
    const second = targeted({ ...BASE, title: "T2" });
    await tick();
    expect(sent).toHaveLength(1); // the second waited
    pending[0].resolve(saved("row-1"));
    await first;
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ draftId: "row-1", title: "T2" });
    expect(sent[1].newDraft).toBeUndefined();
    pending[1].resolve(saved("row-1"));
    await expect(second).resolves.toEqual(saved("row-1"));
  });

  it("mints again after a first save that failed, and only once", async () => {
    const { sent, pending, targeted } = rig();
    const first = targeted(BASE);
    const a = targeted(BASE);
    const b = targeted(BASE);
    pending[0].reject(new Error("down"));
    await expect(first).rejects.toThrow("down");
    await tick();
    expect(sent.filter((d) => d.newDraft)).toHaveLength(2); // the failed one + ONE retry
    pending[1].resolve(saved("row-2"));
    await tick();
    expect(sent[2]).toMatchObject({ draftId: "row-2" });
    pending[2].resolve(saved("row-2"));
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  it("leaves an explicit target alone", async () => {
    const { sent, pending, targeted } = rig();
    const p = targeted({ ...BASE, draftId: "known" });
    const q = targeted({ ...BASE, dTag: "a-live-piece" });
    pending[0].resolve(saved("known"));
    pending[1].resolve(saved("edit-row"));
    await Promise.all([p, q]);
    expect(sent.every((d) => d.newDraft === undefined)).toBe(true);
  });
});
