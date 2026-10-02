import { describe, it, expect } from "vitest";
import { nip19 } from "nostr-tools";
import {
  nostrEventUri,
  nostrAddrUri,
  decodeNostrEventId,
  nostrTargetTag,
  nostrRootId,
  nostrReplyTargetId,
  parseNostrProfile,
  normaliseNostrThreadNode,
  isParameterizedReplaceable,
  type RawNostrEvent,
} from "../src/lib/nostr-thread.js";

// Pure helpers backing the Nostr branch of hydrateExternalThreadContext
// (external-items.ts). The load-bearing invariant is relay-free identity
// parity with the ingest path (feed-ingest-nostr.ts): a hydrated reply's
// source_reply_uri must equal its parent's source_item_uri, or
// assembleExternalThread's DB walk can't connect them (UNIVERSAL-POST §2.1, C1).

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const ID_ROOT = "c".repeat(64);
const PUBKEY = "d".repeat(64);

function ev(partial: Partial<RawNostrEvent>): RawNostrEvent {
  return {
    id: ID_A,
    pubkey: PUBKEY,
    kind: 1,
    content: "",
    created_at: 1_700_000_000,
    tags: [],
    ...partial,
  };
}

describe("relay-free identity encoding", () => {
  it("nostrEventUri round-trips through decodeNostrEventId", () => {
    const uri = nostrEventUri(ID_A);
    expect(uri.startsWith("nevent1")).toBe(true);
    expect(decodeNostrEventId(uri)).toBe(ID_A);
  });

  it("a reply's source_reply_uri equals its parent's source_item_uri", () => {
    // parent stores source_item_uri = nostrEventUri(parent.id); the child's
    // NIP-10 reply tag points at parent.id and is encoded the same way.
    const parentUri = nostrEventUri(ID_B);
    const child = normaliseNostrThreadNode(
      ev({ id: ID_A, tags: [["e", ID_B, "", "reply"]] }),
      [],
      { name: null, picture: null, nip05: null },
    );
    expect(child.sourceReplyUri).toBe(parentUri);
  });

  it("encoding carries no relay hint (relay-free)", () => {
    // Two ingests of the same event from different relays must mint the same uri.
    expect(nostrEventUri(ID_A)).toBe(nostrEventUri(ID_A));
    expect(nostrEventUri(ID_A)).not.toContain("relay");
  });
});

describe("decodeNostrEventId", () => {
  it("accepts a bare 64-char hex id (lowercased)", () => {
    expect(decodeNostrEventId(ID_A.toUpperCase())).toBe(ID_A);
  });
  it("decodes a note1 string", () => {
    expect(decodeNostrEventId(nip19.noteEncode(ID_A))).toBe(ID_A);
  });
  it("decodes an nevent1 string", () => {
    expect(decodeNostrEventId(nip19.neventEncode({ id: ID_A }))).toBe(ID_A);
  });
  it("returns null for null/empty/garbage", () => {
    expect(decodeNostrEventId(null)).toBeNull();
    expect(decodeNostrEventId("")).toBeNull();
    expect(decodeNostrEventId("not-a-nip19-string")).toBeNull();
    // an naddr is not an event id
    expect(decodeNostrEventId(nostrAddrUri(30023, PUBKEY, "slug"))).toBeNull();
  });
});

describe("nostrTargetTag — an outbound reference to a stored uri (S17)", () => {
  // An external nostr item's source_item_uri is a relay-free nevent/naddr (the
  // relay-free identity invariant). An `e` tag's value is the 64-char hex event
  // id and nothing else, so the two outbound routes in external-items/
  // interactions.ts, which put the bech32 string straight into one, produced a
  // like and a reply every relay accepted and no client could resolve.
  it("an nevent becomes an `e` tag carrying the HEX id, not the bech32", () => {
    const uri = nostrEventUri(ID_A);
    expect(uri.startsWith("nevent1")).toBe(true); // the shape that was shipped
    expect(nostrTargetTag(uri)).toEqual(["e", ID_A]);
  });

  it("a marker is placed in NIP-10's fourth position, with the relay slot empty", () => {
    expect(nostrTargetTag(nostrEventUri(ID_A), "root")).toEqual([
      "e",
      ID_A,
      "",
      "root",
    ]);
  });

  it("an naddr becomes an `a` tag — an addressable event has no id to point at", () => {
    // A kind-30023 long-form is addressed by coordinate (NIP-01; NIP-25 for a
    // reaction), so `e` is not merely the wrong encoding, it is the wrong tag.
    const uri = nostrAddrUri(30023, PUBKEY, "my-essay");
    expect(nostrTargetTag(uri, "root")).toEqual([
      "a",
      `30023:${PUBKEY}:my-essay`,
      "",
      "root",
    ]);
  });

  it("a bare hex id is accepted unchanged", () => {
    expect(nostrTargetTag(ID_A)).toEqual(["e", ID_A]);
  });

  it("anything else returns null so the caller can REFUSE", () => {
    // Emitting a reference nothing can follow is worse than declining: the
    // member is told their like did not go out, rather than believing it did.
    expect(nostrTargetTag("https://example.com/post/1")).toBeNull();
    expect(nostrTargetTag(nip19.npubEncode(PUBKEY))).toBeNull();
    expect(nostrTargetTag("")).toBeNull();
  });
});

describe("nostrRootId (NIP-10)", () => {
  it("prefers the e-tag marked 'root'", () => {
    const e = ev({
      tags: [
        ["e", ID_B, "", "reply"],
        ["e", ID_ROOT, "", "root"],
      ],
    });
    expect(nostrRootId(e)).toBe(ID_ROOT);
  });
  it("falls back to the first e-tag when unmarked (positional convention)", () => {
    const e = ev({
      tags: [
        ["e", ID_ROOT],
        ["e", ID_B],
      ],
    });
    expect(nostrRootId(e)).toBe(ID_ROOT);
  });
  it("treats an event with no e-tags as its own root", () => {
    expect(nostrRootId(ev({ id: ID_A, tags: [["p", PUBKEY]] }))).toBe(ID_A);
  });
});

describe("nostrReplyTargetId (NIP-10 ancestor walk) ", () => {
  it("prefers the e-tag marked 'reply' over root", () => {
    const e = ev({
      tags: [
        ["e", ID_ROOT, "", "root"],
        ["e", ID_B, "", "reply"],
      ],
    });
    expect(nostrReplyTargetId(e)).toBe(ID_B);
  });
  it("falls back to the last e-tag when unmarked (positional)", () => {
    const e = ev({ tags: [["e", ID_ROOT], ["e", ID_B]] });
    expect(nostrReplyTargetId(e)).toBe(ID_B);
  });
  it("returns null for a root (no e-tags)", () => {
    expect(nostrReplyTargetId(ev({ tags: [["p", PUBKEY]] }))).toBeNull();
  });
  it("agrees with the encoded sourceReplyUri the node carries", () => {
    // the walk fetches by this id; the stored node encodes the same id as an
    // nevent — they must point at the same parent or the chain won't link.
    const e = ev({ tags: [["e", ID_B, "", "reply"]] });
    const target = nostrReplyTargetId(e);
    const node = normaliseNostrThreadNode(e, [], {
      name: null,
      picture: null,
      nip05: null,
    });
    expect(node.sourceReplyUri).toBe(nostrEventUri(target!));
  });
});

describe("parseNostrProfile (kind-0)", () => {
  it("prefers display_name over name", () => {
    const p = parseNostrProfile(
      JSON.stringify({ display_name: "Alice Liddell", name: "alice" }),
    );
    expect(p.name).toBe("Alice Liddell");
  });
  it("falls back to name when display_name is blank/absent", () => {
    expect(parseNostrProfile(JSON.stringify({ name: "alice" })).name).toBe(
      "alice",
    );
    expect(
      parseNostrProfile(JSON.stringify({ display_name: "  ", name: "alice" }))
        .name,
    ).toBe("alice");
  });
  it("extracts picture and nip05, ignores non-strings", () => {
    const p = parseNostrProfile(
      JSON.stringify({
        picture: "https://cdn/a.jpg",
        nip05: "alice@example.com",
        name: 42,
      }),
    );
    expect(p.picture).toBe("https://cdn/a.jpg");
    expect(p.nip05).toBe("alice@example.com");
    expect(p.name).toBeNull();
  });
  // `website` is persisted verbatim and rendered as an `href` on the byline
  // hover card (MIRROR-AUDIT-2026-09-08 §2.4). React 18 renders a
  // `javascript:` href — it only logs that a future version will block it — so
  // this refusal is the first of the two guards, the render-side
  // `safeHttpUrl` being the second. Mutation: drop `httpUrlOrNull` here and
  // the payload case fails.
  it("refuses a non-http(s) website rather than persisting it", () => {
    expect(
      parseNostrProfile(JSON.stringify({ website: "javascript:alert(1)" }))
        .website,
    ).toBeNull();
    expect(
      parseNostrProfile(JSON.stringify({ website: "  not a url  " })).website,
    ).toBeNull();
    // An ordinary one still comes through, trimmed as it always was.
    expect(
      parseNostrProfile(JSON.stringify({ website: "  https://alice.example  " }))
        .website,
    ).toBe("https://alice.example");
  });
  it("returns all-null on malformed JSON", () => {
    expect(parseNostrProfile("{not json")).toEqual({
      name: null,
      picture: null,
      nip05: null,
      about: null,
      website: null,
      lud16: null,
    });
  });
});

describe("normaliseNostrThreadNode", () => {
  it("maps a kind-1 reply: nevent uri, reply link, profile byline", () => {
    const node = normaliseNostrThreadNode(
      ev({
        id: ID_A,
        content: "hi there",
        tags: [["e", ID_B, "", "reply"]],
        created_at: 1_700_000_000,
      }),
      ["wss://relay.example"],
      { name: "Alice", picture: "https://cdn/a.jpg", nip05: "alice@ex.com" },
    );
    expect(node.sourceItemUri).toBe(nostrEventUri(ID_A));
    expect(node.sourceReplyUri).toBe(nostrEventUri(ID_B));
    expect(node.sourceQuoteUri).toBeNull();
    expect(node.authorName).toBe("Alice");
    expect(node.authorHandle).toBe("alice@ex.com");
    expect(node.authorAvatarUrl).toBe("https://cdn/a.jpg");
    expect(node.contentText).toBe("hi there");
    expect(node.publishedAt).toEqual(new Date(1_700_000_000 * 1000));
    expect(node.interactionData).toMatchObject({
      id: ID_A,
      pubkey: PUBKEY,
      relays: ["wss://relay.example"],
    });
  });

  it("uses the last e-tag as reply target when no 'reply' marker is present", () => {
    const node = normaliseNostrThreadNode(
      ev({ tags: [["e", ID_ROOT], ["e", ID_B]] }),
      [],
      { name: null, picture: null, nip05: null },
    );
    expect(node.sourceReplyUri).toBe(nostrEventUri(ID_B));
  });

  it("has a null reply uri for a root note (no e-tags)", () => {
    const node = normaliseNostrThreadNode(ev({ tags: [] }), [], {
      name: null,
      picture: null,
      nip05: null,
    });
    expect(node.sourceReplyUri).toBeNull();
  });

  it("keys a kind-30023 long-form under naddr and titles the byline fallback", () => {
    const node = normaliseNostrThreadNode(
      ev({
        kind: 30023,
        tags: [
          ["d", "my-article"],
          ["title", "My Article"],
        ],
      }),
      [],
      { name: null, picture: null, nip05: null },
    );
    expect(node.sourceItemUri).toBe(nostrAddrUri(30023, PUBKEY, "my-article"));
    // no kind-0 name → falls back to the article title, then npub.
    expect(node.authorName).toBe("My Article");
  });

  it("falls back to a shortened npub when no profile name or title exists", () => {
    const npub = nip19.npubEncode(PUBKEY);
    const node = normaliseNostrThreadNode(ev({ tags: [] }), [], {
      name: null,
      picture: null,
      nip05: null,
    });
    expect(node.authorName).toBe(`${npub.slice(0, 12)}…`);
    expect(node.authorHandle).toBe(npub);
    expect(node.authorUri).toBe(`https://njump.me/${npub}`);
  });
});

describe("isParameterizedReplaceable", () => {
  it("classifies kinds correctly", () => {
    expect(isParameterizedReplaceable(1)).toBe(false);
    expect(isParameterizedReplaceable(30023)).toBe(true);
    expect(isParameterizedReplaceable(29999)).toBe(false);
    expect(isParameterizedReplaceable(40000)).toBe(false);
  });
});
