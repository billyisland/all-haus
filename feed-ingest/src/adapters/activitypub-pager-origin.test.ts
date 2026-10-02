import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// A PAGER IS NEVER STEERED OFF THE INSTANCE IT STARTED ON (§0aa.4)
//
// `fetchOutbox` follows `body.next` and `resolveFirstPageUrl` follows
// `body.first`, and both are strings a REMOTE SERVER chose. Without an origin
// check the loop walks us onto any host the outbox names, up to `maxPages`
// times per poll, with the actor's authority travelling along in the caller's
// head — every item on that page filed under the actor we thought we were
// reading. `parseNextLink`, the follow-graph pager one workspace over, has
// refused a cross-origin `rel=next` since it was written for exactly this
// reason; the two pagers now agree.
//
// `safeFetch` bounds the damage to "a public URL we fetched", which is why
// this was ranked P3 and not a hole. It is still a hole-shaped P3.
//
// THE ASSERTION IS THE CALL LIST, not the returned items. A pager that
// followed the hostile link and then discarded what it found would return the
// same items as one that never followed it, and only the list of URLs asked
// for can tell those apart — so the foreign host is given a perfectly good
// response to serve, and the test fails if anybody asks it for one.
//
// MUTATION CHECK: replace `sameOriginPageUrl(body.next, nextUrl)` with the old
// `typeof body.next === "string" ? body.next : null` and "refuses a cross-origin
// next" fails; do the same to `body.first` and "refuses a cross-origin first"
// fails.
// =============================================================================

interface Reply {
  status?: number;
  body?: unknown;
}

const responses = new Map<string, Reply>();
const asked: string[] = [];

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(async (url: string) => {
    asked.push(url);
    const hit = responses.get(url);
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    const status = hit.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: JSON.stringify(hit.body ?? {}),
      url,
    };
  }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { fetchOutbox, sameOriginPageUrl } = await import("./activitypub.js");

const HOST = "https://good.example";
const OUTBOX = `${HOST}/users/alice/outbox`;
const PAGE1 = `${HOST}/users/alice/outbox?page=true&limit=20`;
const EVIL_PAGE = "https://evil.example/users/alice/outbox?page=2";

const ACTOR = {
  reader: "outbox" as const,
  apiAccountId: null,
  id: `${HOST}/users/alice`,
  name: "Alice",
  preferredUsername: "alice",
  summary: null,
  icon: null,
  outbox: OUTBOX,
  url: `${HOST}/@alice`,
  host: "good.example",
};

function note(n: number) {
  return {
    type: "Create",
    id: `${HOST}/users/alice/statuses/${n}/activity`,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    published: new Date().toISOString(),
    object: {
      type: "Note",
      id: `${HOST}/users/alice/statuses/${n}`,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      content: `<p>post ${n}</p>`,
      published: new Date().toISOString(),
      attributedTo: `${HOST}/users/alice`,
    },
  };
}

const opts = {
  outboxUrl: OUTBOX,
  cursor: null,
  cutoffMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
  maxPages: 5,
  itemsPerPage: 20,
  maxItems: 50,
};

beforeEach(() => {
  responses.clear();
  asked.length = 0;
  // Always available, so following it is a CHOICE the pager made rather than
  // an error it stumbled into.
  responses.set(EVIL_PAGE, {
    body: { orderedItems: [note(99)], next: null },
  });
});

describe("fetchOutbox", () => {
  it("refuses a cross-origin next, and stops paging", async () => {
    responses.set(OUTBOX, { body: { first: PAGE1 } });
    responses.set(PAGE1, {
      body: { orderedItems: [note(1)], next: EVIL_PAGE },
    });

    const out = await fetchOutbox(ACTOR, opts);

    expect(asked).toEqual([OUTBOX, PAGE1]);
    expect(asked).not.toContain(EVIL_PAGE);
    // The page it DID read is kept — refusing the next link truncates the run,
    // it does not discard the work.
    expect(out.items).toHaveLength(1);
  });

  it("follows a same-origin next, including a relative one", async () => {
    // The control. Without it, a pager that refused EVERY next link would pass
    // the case above perfectly.
    const PAGE2 = `${HOST}/users/alice/outbox?page=3`;
    responses.set(OUTBOX, { body: { first: PAGE1 } });
    responses.set(PAGE1, {
      body: { orderedItems: [note(1)], next: "/users/alice/outbox?page=3" },
    });
    responses.set(PAGE2, { body: { orderedItems: [note(2)], next: null } });

    const out = await fetchOutbox(ACTOR, opts);

    expect(asked).toEqual([OUTBOX, PAGE1, PAGE2]);
    expect(out.items).toHaveLength(2);
  });

  it("refuses a cross-origin first", async () => {
    responses.set(OUTBOX, { body: { first: EVIL_PAGE } });
    await expect(fetchOutbox(ACTOR, opts)).rejects.toThrow(
      /first page is not on the outbox's host/,
    );
    expect(asked).toEqual([OUTBOX]);
  });

  it("refuses a cross-origin first given as an object", async () => {
    responses.set(OUTBOX, { body: { first: { id: EVIL_PAGE } } });
    await expect(fetchOutbox(ACTOR, opts)).rejects.toThrow(
      /first page is not on the outbox's host/,
    );
    expect(asked).toEqual([OUTBOX]);
  });

  // THE THIRD ARM, which had no check at all (§0ab item 7). Some instances
  // answer the outbox URL with an OrderedCollectionPage directly — items
  // inline, no `first` — and the resolver returned that document's own `id`
  // unchecked. A collection naming a foreign id therefore steered page 0 off
  // the instance the poll started on, which is precisely what the two arms
  // above refuse. The arm is the one where the document is describing ITSELF,
  // which is why it read as the safe one.
  it("refuses a cross-origin id on an inlined first page", async () => {
    responses.set(OUTBOX, {
      body: { id: EVIL_PAGE, orderedItems: [note(1)] },
    });
    await expect(fetchOutbox(ACTOR, opts)).rejects.toThrow(
      /first page is not on the outbox's host/,
    );
    expect(asked).toEqual([OUTBOX]);
    expect(asked).not.toContain(EVIL_PAGE);
  });

  // The control for it. A resolver that refused EVERY inlined page — or that
  // threw "no first page URL" on this shape — would pass the case above
  // perfectly while breaking every instance that serves this way.
  it("accepts a same-origin id on an inlined first page", async () => {
    const SELF = `${HOST}/users/alice/outbox?page=true`;
    responses.set(OUTBOX, {
      body: { id: SELF, orderedItems: [note(1)] },
    });
    responses.set(SELF, { body: { orderedItems: [note(1)], next: null } });

    const out = await fetchOutbox(ACTOR, opts);

    expect(asked).toEqual([OUTBOX, SELF]);
    expect(out.items).toHaveLength(1);
  });
});

describe("sameOriginPageUrl", () => {
  it("compares the whole origin, not the hostname", () => {
    // A port or a scheme change is a different origin, and the follow-graph
    // pager has always said so. `good.example:8443` is not `good.example`.
    expect(sameOriginPageUrl("https://good.example:8443/x", OUTBOX)).toBeNull();
    expect(sameOriginPageUrl("http://good.example/x", OUTBOX)).toBeNull();
    // And a lookalike host must not pass on a prefix match.
    expect(sameOriginPageUrl("https://good.example.evil/x", OUTBOX)).toBeNull();
  });

  it("returns null for a non-string, an empty string, and a non-http scheme", () => {
    for (const bad of [undefined, null, 42, {}, "", "javascript:alert(1)", "data:text/html,x"]) {
      expect(sameOriginPageUrl(bad, OUTBOX)).toBeNull();
    }
  });

  it("resolves a relative reference against the page that named it", () => {
    // Relative is conformant and common on smaller implementations, and it is
    // same-origin by construction — which is why the check is on the RESOLVED
    // origin rather than on whether the string looked absolute.
    expect(sameOriginPageUrl("?page=2", PAGE1)).toBe(
      `${HOST}/users/alice/outbox?page=2`,
    );
    expect(sameOriginPageUrl("../bob/outbox", OUTBOX)).toBe(
      `${HOST}/users/bob/outbox`,
    );
  });
});
