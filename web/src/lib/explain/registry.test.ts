import { describe, it, expect } from "vitest";
import { firstRunBeats } from "./registry";
import { FIRST_RUN_COPY } from "./copy";

// The first-run tour, rebuilt for the queue (T1, WORKSPACE-QUEUE-ADR §XI.6).
//
// MUTATION LOG (each applied to registry.ts, the suite re-run, reverted):
//   1. the ∀ beat's fork flipped (`canWrite ? discReader : disc`) ⇒ both
//      "∀ beat" cases fail.                                        DETECTED
//   2. `canWrite = false` default changed to `true` ⇒ "an absent canWrite
//      reads as a reader" fails.                                   DETECTED
//   3. the library beat made unconditional ⇒ "six without reading" fails.
//                                                                  DETECTED

const kinds = (b: ReturnType<typeof firstRunBeats>) => b.map((x) => x.kind);

describe("firstRunBeats", () => {
  it("six beats without reading, seven with — never more than seven", () => {
    for (const canWrite of [true, false]) {
      expect(firstRunBeats({ fromStarter: false, canWrite })).toHaveLength(6);
      expect(
        firstRunBeats({ fromStarter: false, canWrite, hasReading: true }),
      ).toHaveLength(7);
    }
  });

  it("describes the queue, not the floor", () => {
    const beats = firstRunBeats({ fromStarter: true, hasReading: true });
    expect(kinds(beats)).not.toContain("floor");
    expect(kinds(beats)).toEqual([
      "vessel",
      "vessel.addSource",
      "card.byline",
      "disc",
      "disc",
      "queue",
      "queue",
    ]);
    // The floor's "They stay where you put them" is gone from every beat.
    for (const b of beats) expect(b.copy).not.toMatch(/where you put them/);
    // The last two float; only the last is done.
    expect(beats.slice(-2).every((b) => b.alwaysFloat)).toBe(true);
    expect(beats.filter((b) => b.done)).toEqual([beats[beats.length - 1]]);
  });

  it("∀ beat: a writer is told the menu is for writing", () => {
    const disc = firstRunBeats({ fromStarter: false, canWrite: true })[3];
    expect(disc.kind).toBe("disc");
    expect(disc.copy).toBe(FIRST_RUN_COPY.disc);
    expect(disc.copy).toMatch(/writing/);
  });

  it("∀ beat: a reader is not promised writing", () => {
    for (const hasReading of [false, true]) {
      const beats = firstRunBeats({
        fromStarter: false,
        canWrite: false,
        hasReading,
      });
      expect(beats[3].copy).toBe(FIRST_RUN_COPY.discReader);
      for (const b of beats) expect(b.copy).not.toMatch(/\bwrit(e|ing)\b/i);
    }
  });

  it("an absent canWrite reads as a reader", () => {
    expect(firstRunBeats({ fromStarter: false })[3].copy).toBe(
      FIRST_RUN_COPY.discReader,
    );
  });

  it("the library beat follows the ∀ beat, only with reading", () => {
    const with_ = firstRunBeats({ fromStarter: false, hasReading: true });
    expect(with_[4].copy).toBe(FIRST_RUN_COPY.library);
    const without = firstRunBeats({ fromStarter: false });
    expect(without.map((b) => b.copy)).not.toContain(FIRST_RUN_COPY.library);
  });

  it("beat 1 forks on provenance", () => {
    expect(firstRunBeats({ fromStarter: true })[0].copy).toBe(
      FIRST_RUN_COPY.vesselStarter,
    );
    expect(firstRunBeats({ fromStarter: false })[0].copy).toBe(
      FIRST_RUN_COPY.vesselNeutral,
    );
  });
});
