import { describe, it, expect } from "vitest";
import { pickNostrWriteRelays } from "../src/lib/nip65.js";

// EXTERNAL-AUTHOR-HISTORY-ADR §4.1 — the pure NIP-65 parser both packages share.

const ev = (created_at: number, tags: string[][]) => ({ created_at, tags });

describe("pickNostrWriteRelays", () => {
  it("returns [] for no events", () => {
    expect(pickNostrWriteRelays([])).toEqual([]);
  });

  it("keeps unmarked and write-marked r tags, drops read-marked", () => {
    const relays = pickNostrWriteRelays([
      ev(100, [
        ["r", "wss://write.example"],
        ["r", "wss://both.example", ""],
        ["r", "wss://writeonly.example", "write"],
        ["r", "wss://readonly.example", "read"],
      ]),
    ]);
    expect(relays).toEqual([
      "wss://write.example",
      "wss://both.example",
      "wss://writeonly.example",
    ]);
  });

  it("picks the newest event by created_at across multiple 10002s", () => {
    const relays = pickNostrWriteRelays([
      ev(100, [["r", "wss://old.example"]]),
      ev(300, [["r", "wss://newest.example"]]),
      ev(200, [["r", "wss://mid.example"]]),
    ]);
    expect(relays).toEqual(["wss://newest.example"]);
  });

  it("rejects non-websocket schemes and malformed tags", () => {
    const relays = pickNostrWriteRelays([
      ev(100, [
        ["r", "https://not-a-relay.example"],
        ["r"],
        ["e", "wss://wrong-tag.example"],
        ["r", 42 as unknown as string],
        ["r", "wss://good.example"],
      ]),
    ]);
    expect(relays).toEqual(["wss://good.example"]);
  });

  it("accepts ws:// as well as wss://", () => {
    expect(
      pickNostrWriteRelays([ev(1, [["r", "ws://plain.example"]])]),
    ).toEqual(["ws://plain.example"]);
  });

  it("dedupes repeated relay URLs", () => {
    const relays = pickNostrWriteRelays([
      ev(100, [
        ["r", "wss://dup.example"],
        ["r", "wss://dup.example", "write"],
        ["r", "wss://other.example"],
      ]),
    ]);
    expect(relays).toEqual(["wss://dup.example", "wss://other.example"]);
  });

  it("caps at 8 relays", () => {
    const tags = Array.from({ length: 12 }, (_, i) => [
      "r",
      `wss://relay${i}.example`,
    ]);
    expect(pickNostrWriteRelays([ev(100, tags)])).toHaveLength(8);
  });

  it("returns [] when the newest event has no usable r tags", () => {
    expect(
      pickNostrWriteRelays([ev(100, [["r", "wss://x.example", "read"]])]),
    ).toEqual([]);
  });
});
