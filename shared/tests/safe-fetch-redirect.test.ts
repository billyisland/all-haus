import { describe, it, expect, beforeEach, vi } from "vitest";

// =============================================================================
// M25 — safeFetch's redirect-hop credential handling.
//
// The risk this closes is exfiltration: callers thread a USER's credential into
// safeFetch (activitypub-resolve passes a reader's Mastodon Bearer token), so a
// hostile or compromised instance answering 302 → https://evil.example would be
// handed that token on the next hop. The fix strips Authorization/Cookie/
// Proxy-Authorization whenever the hop crosses an origin, and downgrades
// 301/302/303 POST→GET with the body dropped (browser/fetch semantics).
//
// What is mocked and why: ONLY the transport (undici's fetch) and DNS. The
// strip-and-downgrade logic under test lives in safeFetch itself, BETWEEN hops,
// so mocking the transport is what makes it observable — every assertion here
// reads the headers the transport was actually handed on hop 2. Mocking safeFetch
// (as gateway/tests/activitypub-follow-reader.test.ts does) would mock away the
// defence and prove nothing. DNS is mocked so the SSRF guard clears the fixture
// hostnames without a network round-trip; no socket is ever opened.
//
// The same-origin cases are the controls: they prove these tests can tell the
// difference between "stripped on cross-origin" and "never sent / always
// stripped" — without them a safeFetch that dropped every header would pass.
// =============================================================================

vi.mock("node:dns/promises", () => ({
  default: {
    // Any fixture hostname resolves to a public address, so
    // resolveAndValidateHost clears it and pins to it. Never contacted: the
    // transport below is mocked.
    resolve4: vi.fn(async () => ["93.184.216.34"]),
    resolve6: vi.fn(async () => []),
  },
}));

const { undiciFetch } = vi.hoisted(() => ({ undiciFetch: vi.fn() }));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  // Agent stays real — buildPinnedAgent constructs one per hop; it just never
  // connects, because fetch is ours.
  return { ...actual, fetch: undiciFetch };
});

const { safeFetch } = await import("../src/lib/http-client.js");

const TOKEN = "Bearer user-mastodon-token";

function redirectTo(status: number, location: string) {
  return { status, ok: false, headers: new Headers({ location }), body: null };
}

function okResponse(text = "ok") {
  return {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "text/plain" }),
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
  };
}

/** The headers the transport was handed on hop `i`, lowercased for lookup. */
function hopHeaders(i: number): Record<string, string> {
  const opts = undiciFetch.mock.calls[i][1] as { headers: Record<string, string> };
  return Object.fromEntries(
    Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
}
const hopUrl = (i: number) => undiciFetch.mock.calls[i][0] as string;
const hopMethod = (i: number) =>
  (undiciFetch.mock.calls[i][1] as { method: string }).method;
const hopBody = (i: number) =>
  (undiciFetch.mock.calls[i][1] as { body: unknown }).body;

beforeEach(() => {
  undiciFetch.mockReset();
});

describe("safeFetch — cross-origin redirect strips credentials (M25)", () => {
  it("drops Authorization on a hop to a different host", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(302, "https://evil.example/collect"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      headers: { Authorization: TOKEN },
    });

    // Hop 1 carries the token (the caller asked for it) …
    expect(hopHeaders(0).authorization).toBe(TOKEN);
    // … hop 2 is a different origin, so it must not.
    expect(hopUrl(1)).toBe("https://evil.example/collect");
    expect(hopHeaders(1).authorization).toBeUndefined();
    // Non-credential headers survive — this strips credentials, not everything.
    expect(hopHeaders(1)["user-agent"]).toContain("all.haus");
  });

  it("drops Cookie and Proxy-Authorization too, whatever the header casing", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(302, "https://evil.example/collect"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      headers: {
        AUTHORIZATION: TOKEN,
        cookie: "session=abc123",
        "Proxy-Authorization": "Basic Zm9v",
        "X-Trace": "keep-me",
      },
    });

    const h = hopHeaders(1);
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
    expect(h["proxy-authorization"]).toBeUndefined();
    expect(h["x-trace"]).toBe("keep-me");
  });

  it("drops credentials when only the SCHEME changes (https → http)", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(302, "http://origin-a.example/plain"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      headers: { Authorization: TOKEN },
    });

    // Same host, but a downgrade to cleartext — the token must not ride it.
    expect(hopHeaders(1).authorization).toBeUndefined();
  });

  it("drops credentials when only the PORT changes", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(302, "https://origin-a.example:8443/other"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      headers: { Authorization: TOKEN },
    });

    expect(hopHeaders(1).authorization).toBeUndefined();
  });

  it("CONTROL: keeps Authorization on a same-origin hop", async () => {
    // Without this, a safeFetch that stripped every header on every hop — or one
    // that never forwarded headers at all — would pass every test above.
    undiciFetch
      .mockResolvedValueOnce(redirectTo(302, "https://origin-a.example/moved"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      headers: { Authorization: TOKEN },
    });

    expect(hopUrl(1)).toBe("https://origin-a.example/moved");
    expect(hopHeaders(1).authorization).toBe(TOKEN);
  });

  it("CONTROL: keeps Authorization across a same-origin RELATIVE redirect", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(302, "/moved"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      headers: { Authorization: TOKEN },
    });

    expect(hopUrl(1)).toBe("https://origin-a.example/moved");
    expect(hopHeaders(1).authorization).toBe(TOKEN);
  });

  it("a stripped credential stays stripped across a later same-origin hop", async () => {
    // a.example → evil.example (strip) → evil.example/final (same-origin, but the
    // token is already gone and must not reappear).
    undiciFetch
      .mockResolvedValueOnce(redirectTo(302, "https://evil.example/one"))
      .mockResolvedValueOnce(redirectTo(302, "https://evil.example/final"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      headers: { Authorization: TOKEN },
    });

    expect(hopHeaders(1).authorization).toBeUndefined();
    expect(hopHeaders(2).authorization).toBeUndefined();
  });
});

describe("safeFetch — redirect method/body downgrade (M25)", () => {
  for (const status of [301, 302, 303]) {
    it(`${status} downgrades POST → GET and drops the body`, async () => {
      undiciFetch
        .mockResolvedValueOnce(redirectTo(status, "https://origin-a.example/moved"))
        .mockResolvedValueOnce(okResponse());

      await safeFetch("https://origin-a.example/resource", {
        method: "POST",
        body: "payload=1",
      });

      expect(hopMethod(0)).toBe("POST");
      expect(hopBody(0)).toBe("payload=1");
      expect(hopMethod(1)).toBe("GET");
      expect(hopBody(1)).toBeUndefined();
    });
  }

  for (const status of [307, 308]) {
    it(`${status} preserves method and body`, async () => {
      undiciFetch
        .mockResolvedValueOnce(redirectTo(status, "https://origin-a.example/moved"))
        .mockResolvedValueOnce(okResponse());

      await safeFetch("https://origin-a.example/resource", {
        method: "POST",
        body: "payload=1",
      });

      expect(hopMethod(1)).toBe("POST");
      expect(hopBody(1)).toBe("payload=1");
    });
  }

  it("303 leaves HEAD as HEAD (never upgraded to GET)", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(303, "https://origin-a.example/moved"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", { method: "HEAD" });

    expect(hopMethod(1)).toBe("HEAD");
  });

  // §0f-17: 301/302 rewrite POST only — PUT/DELETE re-send unchanged (fetch/
  // browser semantics); the old blanket rewrite silently re-issued them as GET.
  for (const status of [301, 302]) {
    it(`${status} preserves a PUT's method and body (only POST downgrades)`, async () => {
      undiciFetch
        .mockResolvedValueOnce(redirectTo(status, "https://origin-a.example/moved"))
        .mockResolvedValueOnce(okResponse());

      await safeFetch("https://origin-a.example/resource", {
        method: "PUT",
        body: "payload=1",
        headers: { "Content-Type": "text/plain" },
      });

      expect(hopMethod(1)).toBe("PUT");
      expect(hopBody(1)).toBe("payload=1");
      expect(hopHeaders(1)["content-type"]).toBe("text/plain");
    });
  }

  it("303 downgrades a PUT → GET (303 rewrites every method except HEAD)", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(303, "https://origin-a.example/moved"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      method: "PUT",
      body: "payload=1",
    });

    expect(hopMethod(1)).toBe("GET");
    expect(hopBody(1)).toBeUndefined();
  });

  it("a downgrade strips the dropped body's describing headers (§0f-17)", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(302, "https://origin-a.example/moved"))
      .mockResolvedValueOnce(okResponse());

    await safeFetch("https://origin-a.example/resource", {
      method: "POST",
      body: "payload=1",
      headers: { "Content-Type": "application/json", "Content-Length": "9" },
    });

    expect(hopMethod(1)).toBe("GET");
    expect(hopHeaders(1)["content-type"]).toBeUndefined();
    expect(hopHeaders(1)["content-length"]).toBeUndefined();
    // Non-body headers survive the strip.
    expect(hopHeaders(1)["user-agent"]).toContain("all.haus");
  });
});

// =============================================================================
// §8.14 — 304 is not a redirect.
//
// safeFetch treated the whole 3xx range as "redirect", so a 304 Not Modified —
// the successful answer to the conditional GET feed-ingest's rss adapter makes,
// and by definition Location-less — threw `Redirect 304 with no Location
// header`. That error increments external_sources.error_count, which
// deactivates the source at 10: a feed could be switched off for behaving well.
// Measured on dev: simonwillison.net/atom/everything/ sat at error_count 5.
//
// The controls matter more than usual here, because the fix NARROWS a
// condition: a test that only proves 304 comes back cannot tell you the
// redirect handling still works. Each case below therefore pairs with a real
// redirect status that must behave exactly as before.
// =============================================================================

function notModified(headers: Record<string, string> = {}) {
  // A 304 carries validators and no body — this is what an origin actually
  // sends, hence `body: null` (safeFetch's reader path handles bodyless).
  return { status: 304, ok: false, headers: new Headers(headers), body: null };
}

describe("safeFetch — 304 Not Modified is not a redirect (§8.14)", () => {
  it("returns the 304 to the caller instead of throwing", async () => {
    undiciFetch.mockResolvedValueOnce(notModified({ etag: '"v2"' }));

    const res = await safeFetch("https://feed.example/atom", {
      headers: { "If-None-Match": '"v2"' },
    });

    expect(res.status).toBe(304);
    expect(res.ok).toBe(false);
    // The caller needs the validators to store for next time.
    expect(res.headers.get("etag")).toBe('"v2"');
    // And it must not have been followed anywhere: one hop, the original URL.
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(res.url).toBe("https://feed.example/atom");
  });

  it("CONTROL: a real redirect with no Location still throws", async () => {
    undiciFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers(),
      body: null,
    });

    await expect(safeFetch("https://feed.example/atom")).rejects.toThrow(
      /no Location header/,
    );
  });

  it("CONTROL: a real redirect is still followed", async () => {
    undiciFetch
      .mockResolvedValueOnce(redirectTo(301, "https://feed.example/atom.xml"))
      .mockResolvedValueOnce(okResponse("<feed/>"));

    const res = await safeFetch("https://feed.example/atom");

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(hopUrl(1)).toBe("https://feed.example/atom.xml");
    expect(res.text).toBe("<feed/>");
  });

  it("the other non-redirect 3xx codes come back as ordinary responses", async () => {
    // 300 Multiple Choices, 305 and 306 are not redirect statuses either; a
    // Location-less one used to throw the same misleading error.
    for (const status of [300, 305, 306]) {
      undiciFetch.mockReset();
      undiciFetch.mockResolvedValueOnce({
        status,
        ok: false,
        headers: new Headers(),
        body: null,
      });

      const res = await safeFetch("https://feed.example/atom");
      expect(res.status).toBe(status);
      expect(res.ok).toBe(false);
    }
  });

  // Mutation-checked against the pre-fix `status >= 300 && < 400`: the first and
  // fourth cases above fail, the two redirect controls pass (as controls must),
  // and THIS one passes either way — the manual branch already returned a 3xx
  // to the caller, so it pins the manual path's unchanged behaviour rather than
  // the fix. Said out loud because a test that cannot fail is not evidence.
  it("CONTROL (non-discriminating): a 304 under redirect:manual is returned", async () => {
    undiciFetch.mockResolvedValueOnce(notModified({ etag: '"v2"' }));

    const res = await safeFetch("https://feed.example/atom", {
      redirect: "manual",
    });

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v2"');
  });
});
